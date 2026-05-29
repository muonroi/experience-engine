/**
 * evolution.js — Experience Evolution pipeline
 * Extracted from experience-core.js. Zero npm dependencies.
 *
 * Functions: organic support consolidation, promotion/demotion, stores, evolve loop.
 */
'use strict';

const crypto = require('crypto');
const {
  SELFQA_COLLECTION, getExpUser,
  getQdrantBase, getQdrantApiKey, getMinConfidence, COLLECTIONS,
  DEDUP_THRESHOLD,
} = require('./config');
// activityLog must come from ./activity (the real writer). The activityLog
// exported by ./config is a no-op stub guarded by setActivityLog() which is
// never invoked anywhere in the tree — relic from a half-finished modular
// refactor. Importing from ./activity matches hittrack.js / intercept.js.
const { activityLog } = require('./activity');
const { getEmbedding } = require('./embedding');
const {
  searchCollection, fileStoreRead, fileStoreUpsert,
  cosineSimilarity, checkQdrant, setQdrantAvailable, buildQdrantUserFilter, deleteEntry,
} = require('./qdrant');
const { normalizeExtractText, assessExtractedQaQuality } = require('./context');
const {
  ensureSignalMetrics, ensureNovelCaseEvidence,
  buildPrincipleText, buildStorePayload,
  normalizeFailureMode, normalizeJudgment, normalizeEvidenceClass,
} = require('./format');
const { computeEffectiveConfidence } = require('./scoring');
const { getValidatedHitCount } = require('./utils');
const { callBrainWithFallback } = require('./brain-llm');
const { createEdge } = require('./graph');

// --- Local constants (not yet in config.js) ---

const ORGANIC_SUPPORT_SEMANTIC_THRESHOLD = 0.58;
const ORGANIC_SUPPORT_TOKEN_OVERLAP_THRESHOLD = 0.34;
const ORGANIC_SUPPORT_MAX_CANDIDATES = 8;
const RELATES_TO_THRESHOLD = 0.70;
const T2_TO_T1_HIT_THRESHOLD = 2;
const T2_TO_T1_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PROBATIONARY_PRINCIPLE_HIT_THRESHOLD = 2;
const BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 8;
const BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.78;
const BEHAVIORAL_TO_PRINCIPLE_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 5;
const SEEDED_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.72;
const DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD = 4;
const DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE = 0.64;
const PROMOTE_COOLDOWN_MS = 48 * 60 * 60 * 1000;

const ORGANIC_SUPPORT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'before', 'after', 'ensure', 'always', 'should', 'must', 'have', 'has', 'are',
  'was', 'were', 'will', 'using', 'used', 'file', 'files', 'command',
]);

// --- Organic support consolidation ---

function tokenizeOrganicSupportText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\/-]+/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !ORGANIC_SUPPORT_STOPWORDS.has(token));
}

function organicSupportText(input = {}) {
  return [
    input.failureMode,
    input.judgment,
    input.trigger,
    input.question,
    input.solution,
    ...(Array.isArray(input.conditions) ? input.conditions : []),
  ].filter(Boolean).join(' ');
}

function tokenOverlapRatio(a, b) {
  const aTokens = new Set(tokenizeOrganicSupportText(a));
  const bTokens = new Set(tokenizeOrganicSupportText(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return overlap / Math.min(aTokens.size, bTokens.size);
}

function conditionOverlapCount(a, b) {
  const aConditions = new Set((Array.isArray(a?.conditions) ? a.conditions : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  const bConditions = new Set((Array.isArray(b?.conditions) ? b.conditions : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  let count = 0;
  for (const condition of aConditions) {
    if (bConditions.has(condition)) count++;
  }
  return count;
}

function buildOrganicSupportKey(data) {
  return `${normalizeExtractText(data?.trigger)}||${normalizeExtractText(data?.solution)}`;
}

function isOrganicSupportCandidate(qa, existing, semanticScore = 0) {
  if (!qa || !existing) return false;
  if (existing.createdFrom && existing.createdFrom !== 'session-extractor') return false;
  if ((existing.ignoreCount || 0) > 0 || (existing.irrelevantCount || 0) > 0) return false;
  const incomingKey = buildOrganicSupportKey(qa);
  const existingKey = buildOrganicSupportKey(existing);
  if (incomingKey && incomingKey === existingKey) return true;
  if (semanticScore < ORGANIC_SUPPORT_SEMANTIC_THRESHOLD) return false;
  const overlap = tokenOverlapRatio(organicSupportText(qa), organicSupportText(existing));
  if (overlap >= ORGANIC_SUPPORT_TOKEN_OVERLAP_THRESHOLD) return true;
  return conditionOverlapCount(qa, existing) >= 2 && overlap >= 0.20;
}

async function findOrganicSupportCandidate(qa, vector) {
  const points = await searchCollection(SELFQA_COLLECTION, vector, ORGANIC_SUPPORT_MAX_CANDIDATES);
  let best = null;
  for (const point of points) {
    const data = parsePayload(point);
    if (!isOrganicSupportCandidate(qa, data, point.score || 0)) continue;
    if (!best || (point.score || 0) > (best.score || 0)) best = { point, data, score: point.score || 0 };
  }
  return best;
}

function applyOrganicSupportUpdate(data, qa, supportId, context = {}) {
  ensureSignalMetrics(data);
  ensureNovelCaseEvidence(data);
  const now = new Date().toISOString();
  const sourceSession = String(qa?.sourceSession || context.sourceSession || '').trim();
  if (!Array.isArray(data.organicSupportSessions)) data.organicSupportSessions = [];
  if (!Array.isArray(data.organicSupportIds)) data.organicSupportIds = [];

  const alreadyConfirmedSession = sourceSession && data.organicSupportSessions.includes(sourceSession);
  if (!alreadyConfirmedSession) {
    data.organicSupportCount = (data.organicSupportCount || 0) + 1;
    data.validatedCount = Math.max(data.validatedCount || 0, data.organicSupportCount || 0);
    data.hitCount = getValidatedHitCount(data);
    data.lastHitAt = now;
    data.lastOrganicSupportAt = now;
    data.confirmedAt.push(now);
    if (data.confirmedAt.length > 50) data.confirmedAt = data.confirmedAt.slice(-50);
  }

  if (sourceSession && !data.organicSupportSessions.includes(sourceSession)) {
    data.organicSupportSessions.push(sourceSession);
    if (data.organicSupportSessions.length > 50) data.organicSupportSessions = data.organicSupportSessions.slice(-50);
    if (!Array.isArray(data.confirmedSessions)) data.confirmedSessions = [];
    if (!data.confirmedSessions.includes(sourceSession)) data.confirmedSessions.push(sourceSession);
    if (data.confirmedSessions.length > 20) data.confirmedSessions = data.confirmedSessions.slice(-20);
    data.lastConfirmedSession = sourceSession;
  }
  if (supportId && !data.organicSupportIds.includes(supportId)) {
    data.organicSupportIds.push(supportId);
    if (data.organicSupportIds.length > 100) data.organicSupportIds = data.organicSupportIds.slice(-100);
  }
  if (supportId && !data.novelCaseEvidence.seedEntryIds.includes(supportId)) {
    data.novelCaseEvidence.seedEntryIds.push(supportId);
    if (data.novelCaseEvidence.seedEntryIds.length > 100) {
      data.novelCaseEvidence.seedEntryIds = data.novelCaseEvidence.seedEntryIds.slice(-100);
    }
  }
  data.novelCaseEvidence.seedSupportCount = Math.max(
    data.novelCaseEvidence.seedSupportCount || 1,
    1 + (data.organicSupportCount || 0)
  );
  const confidenceFloor = 0.50 + Math.min(0.18, (data.organicSupportCount || 0) * 0.04);
  data.confidence = Math.max(Number(data.confidence || 0), confidenceFloor);
  return data;
}

// --- Store ---

async function storeExperience(qa, domain, projectSlug) {
  const text = `${qa.trigger} ${qa.question} ${qa.solution}`;
  const vector = await getEmbedding(text);
  if (!vector) return { stored: false, merged: false };

  const id = crypto.randomUUID();
  const supportCandidate = await findOrganicSupportCandidate(qa, vector);
  if (supportCandidate?.point?.id && supportCandidate.data) {
    applyOrganicSupportUpdate(supportCandidate.data, qa, id);
    await upsertEntry(SELFQA_COLLECTION, supportCandidate.point.id, supportCandidate.point.vector || vector, supportCandidate.data);
    activityLog({
      op: 'extract-merge',
      id: String(supportCandidate.point.id).slice(0, 8),
      supportId: id.slice(0, 8),
      score: Number((supportCandidate.score || 0).toFixed(3)),
      organicSupportCount: supportCandidate.data.organicSupportCount || 0,
      sourceSession: qa.sourceSession || null,
    });
    return { stored: false, merged: true, id: supportCandidate.point.id };
  }

  const storeData = buildStorePayload(id, qa, domain, projectSlug);
  const payload = {
    json: JSON.stringify(storeData),
    user: getExpUser(),
    ...buildScopeFlatFields(storeData),
  };

  if (!(await checkQdrant())) {
    fileStoreUpsert(SELFQA_COLLECTION, id, vector, payload);
  } else {
    await fetch(`${getQdrantBase()}/collections/${SELFQA_COLLECTION}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
      signal: AbortSignal.timeout(5000),
    });
  }

  // Phase 107: Create relates-to and supersedes edges
  if (vector) {
    try {
      const existing = await getAllEntries(SELFQA_COLLECTION);
      for (const entry of existing) {
        if (entry.id === id) continue;
        if (!entry.vector || entry.vector.length !== vector.length) continue;
        const sim = cosineSimilarity(vector, entry.vector);
        if (sim > DEDUP_THRESHOLD) {
          const d = parsePayload(entry);
          if (d && d.trigger && qa.trigger && d.trigger === qa.trigger) {
            createEdge(id, entry.id, 'supersedes', parseFloat(sim.toFixed(3)), 'store-supersedes');
          }
        }
        if (sim > RELATES_TO_THRESHOLD && sim <= DEDUP_THRESHOLD) {
          createEdge(id, entry.id, 'relates-to', parseFloat(sim.toFixed(3)), 'store-similarity');
        }
      }
    } catch { /* never block store on edge creation */ }
  }
  return { stored: true, merged: false, id };
}

// --- Promotion helpers ---

function uniqueConfirmationCount(data, field) {
  const values = Array.isArray(data?.[field]) ? data[field] : [];
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean)).size;
}

function hasRepeatedSessionConfirmations(data, minCount) {
  return uniqueConfirmationCount(data, 'confirmedSessions') >= minCount;
}

function resetPromotionProbation(data, tier) {
  ensureSignalMetrics(data);
  data.tier = tier;
  data.ignoreCount = 0;
  data.irrelevantCount = 0;
  data.unusedCount = 0;
  data.lastNoiseReason = null;
  data.noiseReasonCounts = {};
  if (tier === 1) data.confidence = Math.max(data.confidence || 0.5, 0.6);
  if (tier === 0) data.confidence = Math.max(data.confidence || 0.5, 0.9);
  delete data.demotedAt;
  delete data.demoteReason;
  delete data.demotedFromT0At;
  return data;
}

function shouldPromoteBehavioralToPrinciple(data, now = Date.now()) {
  if (!data || data.createdFrom === 'evolution-abstraction') return false;
  if (
    data.createdFrom === 'session-extractor'
    && getValidatedHitCount(data) >= DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD
    && (data.confidence || 0) >= DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE
    && hasRepeatedSessionConfirmations(data, DOGFOOD_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD)
  ) {
    return true;
  }
  const organicHits = getValidatedHitCount(data);
  const isSeeded = data.createdFrom === 'bulk-seed'
    || data.createdFrom === 'imported'
    || (typeof data.createdFrom === 'string' && data.createdFrom.startsWith('seed-'));
  const minHits = isSeeded ? SEEDED_BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD : BEHAVIORAL_TO_PRINCIPLE_HIT_THRESHOLD;
  const minConfidence = isSeeded ? SEEDED_BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE : BEHAVIORAL_TO_PRINCIPLE_MIN_CONFIDENCE;
  if (organicHits < minHits) return false;
  if ((data.confidence || 0) < minConfidence) return false;
  const createdAt = new Date(data.createdAt || 0).getTime();
  if (!createdAt || Number.isNaN(createdAt)) return false;
  return (now - createdAt) >= BEHAVIORAL_TO_PRINCIPLE_MIN_AGE_MS;
}

// --- Evolve ---

async function evolve(trigger) {
  const results = { promoted: 0, abstracted: 0, demoted: 0, archived: 0 };

  // Step 1: Promote T2 -> T1 (per D-04)
  const t2Entries = await getAllEntries('experience-selfqa');
  for (const entry of t2Entries) {
    const data = parsePayload(entry);
    ensureSignalMetrics(data);
    const quality = assessExtractedQaQuality(data);
    if (data?.createdFrom === 'session-extractor' && !quality.ok) {
      await deleteEntry('experience-selfqa', entry.id);
      results.archived++;
      activityLog({ op: 'evolve-low-quality-cleanup', id: entry.id.slice(0, 8), reason: quality.reason });
      continue;
    }
    if (!data || getValidatedHitCount(data) < T2_TO_T1_HIT_THRESHOLD) continue;
    const demotedAt = data.demotedAt ? new Date(data.demotedAt).getTime() : 0;
    if (demotedAt && (Date.now() - demotedAt) < PROMOTE_COOLDOWN_MS) continue;
    const ageMs = Date.now() - new Date(data.createdAt || 0).getTime();
    const fastDogfoodPromote = data.createdFrom === 'session-extractor'
      && hasRepeatedSessionConfirmations(data, T2_TO_T1_HIT_THRESHOLD);
    if (ageMs < T2_TO_T1_MIN_AGE_MS && !fastDogfoodPromote) continue;
    resetPromotionProbation(data, 1);
    data.provenance = {
      kind: 'seed-support',
      source: data.createdFrom || 'session-extractor',
      sourceSession: data.lastConfirmedSession || null,
    };
    data.promotedAt = new Date().toISOString();
    if (fastDogfoodPromote) data.promotedVia = 'dogfood-confirmation';
    const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
    if (!vector) continue;
    await upsertEntry('experience-behavioral', entry.id, vector, data);
    await deleteEntry('experience-selfqa', entry.id);
    results.promoted++;
  }

  // Step 1b: Promote probationary principles T1 -> T0
  const t1PrincipleEntries = await getAllEntries('experience-behavioral');
  for (const entry of t1PrincipleEntries) {
    const data = parsePayload(entry);
    ensureSignalMetrics(data);
    if (!data) continue;
    const demotedFromT0At = data.demotedFromT0At ? new Date(data.demotedFromT0At).getTime() : 0;
    if (demotedFromT0At && (Date.now() - demotedFromT0At) < PROMOTE_COOLDOWN_MS) continue;
    const promoteProbationary = data.createdFrom === 'evolution-abstraction' && getValidatedHitCount(data) >= PROBATIONARY_PRINCIPLE_HIT_THRESHOLD;
    const promoteMatureBehavioral = shouldPromoteBehavioralToPrinciple(data);
    if (!promoteProbationary && !promoteMatureBehavioral) continue;
    resetPromotionProbation(data, 0);
    data.principle = buildPrincipleText(data);
    data.promotedToT0At = new Date().toISOString();
    data.provenance = {
      kind: 'principle',
      source: data.createdFrom || 'unknown',
      sourceSession: data.lastConfirmedSession || null,
    };
    if (promoteMatureBehavioral) data.promotedFromBehavioralAt = new Date().toISOString();
    const vector = entry.vector || await getEmbedding(buildPrincipleText(data));
    if (!vector) continue;
    await upsertEntry('experience-principles', entry.id, vector, data);
    await deleteEntry('experience-behavioral', entry.id);
    results.promoted++;
  }

  // Step 1c: Repair orphaned evolution-abstraction entries in selfqa.
  // Old code (pre-260512) incorrectly wrote abstraction results to selfqa instead
  // of behavioral. These entries have confidence below the survivable floor and
  // can never be surfaced (isSeedEntry now covers evolution-abstraction, so the
  // ageFactor bypass applies — but Step 3 still uses computeEffectiveConfidence
  // which for seeds = base directly, so floor = minConfidence = 0.55).
  const EVOLUTION_ABS_CONFIDENCE_FLOOR = 0.57; // slightly above minConfidence(0.55)
  const orphanedAbsEntries = await getAllEntries('experience-selfqa');
  for (const entry of orphanedAbsEntries) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'evolution-abstraction') continue;
    if ((data.confidence || 0) >= EVOLUTION_ABS_CONFIDENCE_FLOOR) continue;
    data.confidence = EVOLUTION_ABS_CONFIDENCE_FLOOR;
    data.tier = 1;
    data.repairedAt = new Date().toISOString();
    data.repairReason = 'orphaned-low-confidence-selfqa-abs';
    const vector = entry.vector || await getEmbedding(buildPrincipleText(data) || `${data.trigger} ${data.solution}`);
    if (!vector) continue;
    await upsertEntry('experience-behavioral', entry.id, vector, data);
    await deleteEntry('experience-selfqa', entry.id);
    results.promoted++;
    activityLog({ op: 'evolve-repair-abs-orphan', id: entry.id.slice(0, 8) });
  }

  // Step 2: Abstract T2 clusters -> T0 (per D-05)
  //
  // Tuning history (260512 recon):
  //   Cluster cosine 0.70 was too loose — heterogeneous clusters produced
  //   vague brain summaries that failed round-trip match (8/8 rejected,
  //   matchRate ≤ 0.5). NOTE(260529): 0.78 proved TOO tight — 484 real
  //   session-extractor T2 entries gave 0 clusters@0.78 vs 31@0.72; only
  //   orphan abstractions cleared 0.78 (Step1c removes them) -> abstracted:0.
  //   Lowered to 0.72; round-trip (0.60/0.50) is the real quality gate (5/6 pass).
  const ABSTRACT_CLUSTER_COSINE = 0.72;
  const ROUND_TRIP_MEMBER_COSINE = 0.60;
  const ROUND_TRIP_ACCEPT_RATE = 0.50;
  const remainingT2 = await getAllEntries('experience-selfqa');
  const clustered = clusterByCosine(remainingT2, ABSTRACT_CLUSTER_COSINE);
  for (const cluster of clustered) {
    if (cluster.length < 2) continue;
    const summaries = cluster.map(e => {
      const d = parsePayload(e);
      return d ? `${d.trigger}: ${d.solution}` : '';
    }).filter(Boolean);

    const prompt = `Given these ${summaries.length} related experiences, extract ONE general principle covering all cases. Format as JSON: {"principle":"When [condition], do [action] because [reason]","failureMode":"shared failure family","judgment":"portable preventive judgment","conditions":["keyword1","keyword2","keyword3"],"evidenceClass":"log|test|runtime|review|user-correction|other"}\nConditions = 2-4 keywords that MUST be present for this principle to apply.\nFailure mode must describe the root cause class, not the literal trigger wording.\nJudgment must be portable to a novel case in the same family.\n\n${summaries.join('\n')}`;

    const result = await callBrainWithFallback(prompt, { source: 'evolve' });
    if (!result?.principle) continue;

    const vector = await getEmbedding(result.principle);
    if (!vector) continue;

    let matchCount = 0;
    for (const e of cluster) {
      if (!e.vector || e.vector.length !== vector.length) continue;
      if (cosineSimilarity(vector, e.vector) >= ROUND_TRIP_MEMBER_COSINE) matchCount++;
    }
    if (matchCount / cluster.length < ROUND_TRIP_ACCEPT_RATE) {
      activityLog({ op: 'evolve-reject', reason: 'round-trip-fail', matchRate: matchCount / cluster.length, clusterSize: cluster.length, principle: result.principle.slice(0, 80) });
      continue;
    }

    const id = crypto.randomUUID();
    // Inherit scope from cluster members so abstractions don't land
    // scope-less (strict post-filter would otherwise drop them for any
    // caller with a known lang).
    const inheritedScope = _inheritClusterScope(cluster);
    await upsertEntry('experience-behavioral', id, vector, {
      id, principle: result.principle, solution: result.principle,
      scope: inheritedScope,
      failureMode: normalizeFailureMode(result.failureMode, { question: summaries[0], why: result.principle }),
      judgment: normalizeJudgment(result.judgment, { solution: result.principle }),
      conditions: Array.isArray(result.conditions) ? result.conditions.slice(0, 4) : [],
      evidenceClass: normalizeEvidenceClass(result.evidenceClass, { solution: result.principle }),
      provenance: {
        kind: 'seed-support',
        source: 'evolution-abstraction',
        seedEntryIds: cluster.map((entry) => entry.id),
      },
      novelCaseEvidence: {
        seedSupportCount: cluster.length,
        seedEntryIds: cluster.map((entry) => entry.id),
        holdoutMatchedCount: 0,
        holdoutTestedCount: 0,
        holdoutSessions: [],
        holdoutProjects: [],
        lastMatchedAt: null,
      },
      tier: 1, confidence: Math.min(0.80, 0.50 + (cluster.length / 10) * 0.30), hitCount: 0,
      createdAt: new Date().toISOString(), createdFrom: 'evolution-abstraction',
      sourceCount: cluster.length,
    });

    for (const e of cluster) {
      createEdge(e.id, id, 'generalizes', 1.0, 'evolve-abstraction');
    }
    for (const e of cluster) {
      await deleteEntry('experience-selfqa', e.id);
    }
    results.abstracted++;
  }

  // Step 2b: Demote T0 -> T2 on contradiction
  const t0Entries = await getAllEntries('experience-principles');
  for (const entry of t0Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = (data.ignoreCount || 0) >= 5
      || (data.contradiction && (data.contradictionCount || 1) >= 2);
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.3);
      data.demotedFromT0At = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction' : 'ignored';
      createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-t0-demotion');
      const vector = entry.vector || await getEmbedding(`${data.principle || data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-principles', entry.id);
      results.demoted++;
      activityLog({ op: 'evolve-t0-demote', id: entry.id.slice(0, 8), reason: data.demoteReason });
    }
  }

  // Step 3: Demote T1 -> T2 (per D-06)
  const t1Entries = await getAllEntries('experience-behavioral');
  for (const entry of t1Entries) {
    const data = parsePayload(entry);
    if (!data) continue;
    const shouldDemote = data.contradiction
      || (data.ignoreCount || 0) >= 3
      || computeEffectiveConfidence(data) < getMinConfidence();
    if (shouldDemote) {
      data.tier = 2;
      data.confidence = Math.max(0.1, (data.confidence || 0.5) - 0.2);
      data.demotedAt = new Date().toISOString();
      data.demoteReason = data.contradiction ? 'contradiction'
        : (data.ignoreCount || 0) >= 3 ? 'ignored'
        : 'confidence_decay';
      if (data.demoteReason === 'contradiction' || data.demoteReason === 'ignored') {
        createEdge(entry.id, entry.id, 'contradicts', 0.8, 'evolve-demotion');
      }
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry('experience-selfqa', entry.id, vector, data);
      await deleteEntry('experience-behavioral', entry.id);
      results.demoted++;
    }
  }

  // Step 3b: Auto-supersede chronically ignored entries (any tier).
  //
  // The demote loop above only fires at ignoreCount>=3, which still surfaces
  // the entry from selfqa until age-based archival 90 days later. For entries
  // the agent has rejected en masse (e.g. ignoreRatio ≥ 0.7 over ≥ 5 fires)
  // we hard-mark `superseded:true` so the format/scoring pipeline skips them
  // immediately. The entry stays in Qdrant for audit + potential rollback;
  // it just stops surfacing. computeEffectiveConfidence callers should check
  // superseded before using the score (done elsewhere); the post-filter in
  // experience-core also drops superseded points up front.
  // Tier-based threshold: high-volume entries (≥10 ignores) get aggressive
  // 0.5 cutoff because we have enough signal to be confident; low-volume
  // (5-9 ignores) keep conservative 0.7 to avoid false-positive removal of
  // context-sensitive entries that happen to fire wrong stack a few times.
  const SUPERSEDE_MIN_IGNORE = 5;
  const SUPERSEDE_RATIO_LOW = 0.7;
  const SUPERSEDE_RATIO_HIGH = 0.5;
  const SUPERSEDE_HIGH_VOLUME = 10;
  for (const colName of ['experience-behavioral', 'experience-selfqa', 'experience-principles']) {
    const entries = await getAllEntries(colName);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data || data.superseded) continue;
      const ignores = data.ignoreCount || 0;
      const hits = data.hitCount || 0;
      const total = ignores + hits;
      if (ignores < SUPERSEDE_MIN_IGNORE) continue;
      if (total === 0) continue;
      const ratio = ignores / total;
      const threshold = ignores >= SUPERSEDE_HIGH_VOLUME ? SUPERSEDE_RATIO_HIGH : SUPERSEDE_RATIO_LOW;
      if (ratio < threshold) continue;
      data.superseded = true;
      data.supersededAt = new Date().toISOString();
      data.supersededReason = `auto-decay ignores=${ignores} ratio=${ratio.toFixed(2)} threshold=${threshold}`;
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry(colName, entry.id, vector, data);
      results.archived++;
      activityLog({ op: 'evolve-auto-supersede', id: String(entry.id).slice(0, 8), ignores, ratio: ratio.toFixed(2) });
    }
  }

  // Step 3c: Reason-driven supersede.
  //
  // IRRELEVANT verdicts (vs plain IGNORED) are a stronger noise signal —
  // the agent explicitly classified the hint as wrong (wrong_repo/
  // wrong_language/wrong_task/stale_rule), not just "didn't apply it".
  // When a single reason concentrates ≥ REASON_THRESHOLD votes for an
  // entry, we supersede with that reason as the documented cause. This
  // catches noise entries faster than the ratio-based path (Step 3b) when
  // feedback is concentrated.
  //
  // Future improvement: capture caller meta (lang/project_slug) at
  // /api/feedback time so we can NARROW scope (e.g. exclude TypeScript)
  // instead of full supersede. That needs noiseContextHistory tracking
  // which is a separate diff.
  const REASON_THRESHOLD = 5;
  const TARGET_REASONS = ['wrong_language', 'wrong_repo', 'wrong_task', 'stale_rule'];
  for (const colName of ['experience-behavioral', 'experience-selfqa', 'experience-principles']) {
    const entries = await getAllEntries(colName);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data || data.superseded) continue;
      const reasonCounts = data.noiseReasonCounts || {};
      let trippedReason = null;
      let trippedCount = 0;
      for (const r of TARGET_REASONS) {
        const c = Number(reasonCounts[r] || 0);
        if (c >= REASON_THRESHOLD && c > trippedCount) {
          trippedReason = r;
          trippedCount = c;
        }
      }
      if (!trippedReason) continue;
      data.superseded = true;
      data.supersededAt = new Date().toISOString();
      data.supersededReason = `reason-decay reason=${trippedReason} count=${trippedCount}`;
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry(colName, entry.id, vector, data);
      results.archived++;
      activityLog({ op: 'evolve-reason-supersede', id: String(entry.id).slice(0, 8), reason: trippedReason, count: trippedCount });
    }
  }

  // Step 3d: Scope narrowing from noise context history.
  //
  // If an entry has wrong_language IRRELEVANT votes concentrated from one
  // lang (e.g. 4 of 5 wrong_language votes came from TypeScript queries),
  // narrow its scope to exclude that lang instead of full supersede. Keeps
  // the entry alive for contexts where it might still apply.
  const NARROW_MIN_VOTES = 3;
  const NARROW_DOMINANCE = 0.7; // 70% of single-reason votes from same value
  for (const colName of ['experience-behavioral', 'experience-selfqa', 'experience-principles']) {
    const entries = await getAllEntries(colName);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data || data.superseded) continue;
      const history = Array.isArray(data.noiseContextHistory) ? data.noiseContextHistory : [];
      if (history.length < NARROW_MIN_VOTES) continue;
      const langVotes = {};
      const projectVotes = {};
      let langWrongTotal = 0;
      let projectWrongTotal = 0;
      for (const h of history) {
        if (h.reason === 'wrong_language' && h.lang) {
          langVotes[h.lang] = (langVotes[h.lang] || 0) + 1;
          langWrongTotal++;
        }
        if (h.reason === 'wrong_repo' && h.project_slug) {
          projectVotes[h.project_slug] = (projectVotes[h.project_slug] || 0) + 1;
          projectWrongTotal++;
        }
      }
      let narrowed = false;
      if (langWrongTotal >= NARROW_MIN_VOTES) {
        for (const [lang, count] of Object.entries(langVotes)) {
          if (count / langWrongTotal >= NARROW_DOMINANCE) {
            if (!data.scope || typeof data.scope !== 'object') data.scope = {};
            if (!Array.isArray(data.scope.lang_exclude)) data.scope.lang_exclude = [];
            if (!data.scope.lang_exclude.includes(lang)) {
              data.scope.lang_exclude.push(lang);
              narrowed = true;
              activityLog({ op: 'evolve-scope-narrow', id: String(entry.id).slice(0, 8), excluded_lang: lang, votes: count });
            }
          }
        }
      }
      if (projectWrongTotal >= NARROW_MIN_VOTES) {
        for (const [proj, count] of Object.entries(projectVotes)) {
          if (count / projectWrongTotal >= NARROW_DOMINANCE) {
            if (!data.scope || typeof data.scope !== 'object') data.scope = {};
            if (!Array.isArray(data.scope.project_exclude)) data.scope.project_exclude = [];
            if (!data.scope.project_exclude.includes(proj)) {
              data.scope.project_exclude.push(proj);
              narrowed = true;
              activityLog({ op: 'evolve-scope-narrow', id: String(entry.id).slice(0, 8), excluded_project: proj, votes: count });
            }
          }
        }
      }
      if (!narrowed) continue;
      const vector = entry.vector || await getEmbedding(`${data.trigger} ${data.solution}`);
      if (!vector) continue;
      await upsertEntry(colName, entry.id, vector, data);
    }
  }

  // Step 4: Archive stale T2 (per D-07)
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const allT2 = await getAllEntries('experience-selfqa');
  for (const entry of allT2) {
    const data = parsePayload(entry);
    if (!data) continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age > NINETY_DAYS && (data.hitCount || 0) === 0) {
      await deleteEntry('experience-selfqa', entry.id);
      results.archived++;
    }
  }

  // Step 4b: TTL cleanup for bulk-seeded T1 entries
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  const t1All = await getAllEntries('experience-behavioral');
  for (const entry of t1All) {
    const data = parsePayload(entry);
    if (!data || data.createdFrom !== 'bulk-seed') continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age <= SIXTY_DAYS) continue;
    const hasOrganic = Array.isArray(data.confirmedAt) && data.confirmedAt.length > 0;
    if (!hasOrganic) {
      await deleteEntry('experience-behavioral', entry.id);
      results.archived++;
      activityLog({ op: 'evolve-seed-ttl', id: entry.id.slice(0, 8), age: Math.round(age / (24 * 60 * 60 * 1000)) });
    }
  }

  // Step 4c: Auto-cleanup noise entries
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  for (const collCfg of [{ name: 'experience-behavioral' }, { name: 'experience-selfqa' }]) {
    const entries = await getAllEntries(collCfg.name);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data) continue;
      const ignores = data.ignoreCount || 0;
      const irrelevants = data.irrelevantCount || 0;
      const unuseds = data.unusedCount || 0;
      const hits = data.hitCount || 0;
      const age = now - new Date(data.createdAt || 0).getTime();
      const noiseReasonCounts = data.noiseReasonCounts || {};
      const staleRuleNoise = noiseReasonCounts.stale_rule || 0;
      const ignoredNoise = ignores >= 5 && (hits / Math.max(1, ignores)) < 0.2 && age > THIRTY_DAYS;
      const irrelevantNoise = irrelevants >= 4 && (hits / Math.max(1, irrelevants)) < 0.5 && age > (14 * 24 * 60 * 60 * 1000);
      const unusedNoise = unuseds >= 3 && (hits / Math.max(1, unuseds)) < 0.35 && age > (14 * 24 * 60 * 60 * 1000);
      const staleNoise = staleRuleNoise >= 2 && age > (7 * 24 * 60 * 60 * 1000);
      if (ignoredNoise || irrelevantNoise || unusedNoise || staleNoise) {
        await deleteEntry(collCfg.name, entry.id);
        results.archived++;
        activityLog({
          op: 'evolve-noise-cleanup',
          id: entry.id.slice(0, 8),
          ignores, irrelevants, unuseds, hits, staleRuleNoise,
          age: Math.round(age / (24 * 60 * 60 * 1000)),
        });
      }
    }
  }

  // Step 4d: Hard delete superseded entries.
  // Supersede edges flag obsolete entries (a newer entry with higher conf
  // exists), but the existing flow only marks them and relies on score
  // penalty (-0.15) to suppress. That penalty cannot defeat high-cosine
  // matches, so superseded noise keeps firing. Delete them aggressively:
  // if an entry has been superseded for 24h with zero validated hits, it
  // has had its chance and the replacement is doing the work.
  const ONE_DAY = 24 * 60 * 60 * 1000;
  for (const collCfg of [{ name: 'experience-selfqa' }, { name: 'experience-behavioral' }]) {
    const entries = await getAllEntries(collCfg.name);
    for (const entry of entries) {
      const data = parsePayload(entry);
      if (!data || data.superseded !== true) continue;
      const supersededAt = data.supersededAt ? new Date(data.supersededAt).getTime() : 0;
      const age = supersededAt ? (now - supersededAt) : (now - new Date(data.createdAt || 0).getTime());
      if (age <= ONE_DAY) continue;
      if (getValidatedHitCount(data) > 0) continue;
      await deleteEntry(collCfg.name, entry.id);
      results.archived++;
      activityLog({
        op: 'evolve-superseded-purge',
        id: entry.id.slice(0, 8),
        collection: collCfg.name,
        ignoreCount: data.ignoreCount || 0,
        age: Math.round(age / ONE_DAY),
      });
    }
  }

  // Step 5: Route collection compaction
  const ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const ROUTE_MAX_ENTRIES = 5000;
  try {
    const allRoutes = await getAllEntries('experience-routes');
    let routesPruned = 0;
    for (const entry of allRoutes) {
      const data = parsePayload(entry);
      if (!data) continue;
      const routeAge = now - new Date(data.createdAt || 0).getTime();
      if (routeAge > ROUTE_TTL_MS) {
        await deleteEntry('experience-routes', entry.id);
        routesPruned++;
      }
    }
    if (allRoutes.length - routesPruned > ROUTE_MAX_ENTRIES) {
      const remaining = allRoutes
        .filter(e => { const d = parsePayload(e); return d && (now - new Date(d.createdAt || 0).getTime()) <= ROUTE_TTL_MS; })
        .sort((a, b) => new Date(parsePayload(a)?.createdAt || 0).getTime() - new Date(parsePayload(b)?.createdAt || 0).getTime());
      const excess = remaining.length - ROUTE_MAX_ENTRIES;
      for (let i = 0; i < excess && i < remaining.length; i++) {
        await deleteEntry('experience-routes', remaining[i].id);
        routesPruned++;
      }
    }
    if (routesPruned > 0) {
      results.archived += routesPruned;
      activityLog({ op: 'evolve-route-compaction', pruned: routesPruned });
    }
  } catch { /* best-effort */ }

  // Step 6: Aggressive T2 pruning
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const freshT2 = await getAllEntries('experience-selfqa');
  for (const entry of freshT2) {
    const data = parsePayload(entry);
    if (!data) continue;
    const age = now - new Date(data.createdAt || 0).getTime();
    if (age > FOURTEEN_DAYS && (data.hitCount || 0) === 0 && (data.surfaceCount || 0) === 0) {
      await deleteEntry('experience-selfqa', entry.id);
      results.archived++;
    }
  }

  activityLog({ op: 'evolve', ...results, trigger: trigger || 'auto' });
  return results;
}

// --- Evolution helpers ---

function parsePayload(entry) {
  try { return JSON.parse(entry.payload?.json || '{}'); } catch { return null; }
}

function clusterByCosine(entries, threshold) {
  // Greedy clustering with centroid outlier rejection (Wave 2)
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i) || !entries[i].vector) continue;
    const cluster = [entries[i]];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j) || !entries[j].vector) continue;
      if (cosineSimilarity(entries[i].vector, entries[j].vector) > threshold) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }
    // Wave 2: Centroid outlier rejection — compute centroid, reject members < 0.75 vs centroid
    if (cluster.length >= 3) {
      const dim = cluster[0].vector.length;
      const centroid = new Array(dim).fill(0);
      for (const e of cluster) {
        for (let d = 0; d < dim; d++) centroid[d] += e.vector[d];
      }
      for (let d = 0; d < dim; d++) centroid[d] /= cluster.length;
      const filtered = cluster.filter(e => cosineSimilarity(e.vector, centroid) >= 0.75);
      clusters.push(filtered.length >= 3 ? filtered : cluster); // keep original if filtering drops below 3
    } else {
      clusters.push(cluster);
    }
  }
  return clusters;
}

async function getAllEntries(collection) {
  if (!(await checkQdrant())) {
    return fileStoreRead(collection);
  }
  // Qdrant: scroll all points (filtered by user namespace)
  const points = [];
  let offset = null;
  do {
    try {
      const body = { limit: 100, with_payload: true, with_vector: true, filter: { must: [buildQdrantUserFilter()] } };
      if (offset) body.offset = offset;
      const res = await fetch(`${getQdrantBase()}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.result?.points || [];
      points.push(...batch);
      offset = data.result?.next_page_offset || null;
    } catch { break; }
  } while (offset);
  return points;
}

// Flatten the high-cardinality scope dimensions onto the top-level payload so
// Qdrant can pre-filter at query time using indexed keyword fields. This is the
// single chokepoint — every writer (seed-ingest, evolution, edge, etc.) routes
// through here, so tagging here means no scope field can be set in `data` but
// missed in the indexed payload.
// Compute the scope a Step-2 abstraction should inherit from its cluster
// members. Rule: if >=60% of members agree on a value (lang/framework/
// project_slug), propagate it; otherwise fall back to wildcards
// (lang:"all"/framework:"any"/null slug). Threshold is conservative to
// avoid one outlier flipping the scope of a coherent cluster.
function _inheritClusterScope(cluster) {
  const out = {};
  if (!Array.isArray(cluster) || cluster.length === 0) {
    return { lang: 'all', framework: 'any' };
  }
  // Carry every scope dimension we know about so abstracted entries keep
  // their provenance (runtime + org + project_slug were previously dropped,
  // which made wrong_repo/wrong_language feedback narrowing impossible).
  const dims = ['lang', 'framework', 'project_slug', 'runtime', 'org'];
  const counts = Object.fromEntries(dims.map((d) => [d, new Map()]));
  let total = 0;
  for (const entry of cluster) {
    let data;
    try { data = JSON.parse(entry.payload?.json || '{}'); } catch { continue; }
    if (!data || !data.scope || typeof data.scope !== 'object') continue;
    total++;
    for (const key of dims) {
      const v = data.scope[key];
      if (typeof v !== 'string' || !v.trim()) continue;
      const k = v.toLowerCase().trim();
      counts[key].set(k, (counts[key].get(k) || 0) + 1);
    }
  }
  if (total === 0) return { lang: 'all', framework: 'any' };
  const threshold = Math.ceil(total * 0.6);
  function majority(map, fallback) {
    let best = null, bestN = 0;
    for (const [k, n] of map.entries()) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return (best && bestN >= threshold) ? best : fallback;
  }
  out.lang = majority(counts.lang, 'all');
  out.framework = majority(counts.framework, 'any');
  const slug = majority(counts.project_slug, null);
  if (slug) out.project_slug = slug;
  const runtime = majority(counts.runtime, null);
  if (runtime) out.runtime = runtime;
  const org = majority(counts.org, null);
  if (org) out.org = org;
  return out;
}

function buildScopeFlatFields(data) {
  const flat = {};
  if (data?.scope?.org) flat.scope_org = String(data.scope.org).toLowerCase();
  if (data?.scope?.lang) flat.scope_lang = String(data.scope.lang).toLowerCase();
  if (data?.scope?.framework) flat.scope_framework = String(data.scope.framework).toLowerCase();
  // Flatten project_slug so Qdrant can pre-filter at query time. Read from
  // both scope.project_slug (new) and _projectSlug (legacy root location)
  // so existing entries surface correctly until backfill completes.
  const slug = data?.scope?.project_slug || data?.scope?.projectSlug || data?._projectSlug;
  if (slug) flat.scope_project_slug = String(slug).toLowerCase();
  if (data?.evidenceClass) flat.evidenceClass = String(data.evidenceClass).toLowerCase();
  return flat;
}

async function upsertEntry(collection, id, vector, data) {
  const payload = { json: JSON.stringify(data), user: getExpUser(), ...buildScopeFlatFields(data) };
  if (!(await checkQdrant())) {
    fileStoreUpsert(collection, id, vector, payload);
    return;
  }
  await fetch(`${getQdrantBase()}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
    signal: AbortSignal.timeout(5000),
  });
}

// --- Share/Import principles ---

function sharePrinciple(principleId) {
  const entries = fileStoreRead('experience-principles');
  const entry = entries.find(e => e.id === principleId);
  if (!entry) return null;
  const data = parsePayload(entry);
  if (!data) return null;
  return {
    principle: data.principle || data.solution,
    solution: data.solution,
    confidence: data.confidence,
    domain: data.domain || null,
    sharedAt: new Date().toISOString(),
    sharedBy: getExpUser(),
  };
}

async function importPrinciple(shared) {
  if (!shared?.solution) return null;
  const vector = await getEmbedding(shared.solution);
  if (!vector) return null;
  const id = crypto.randomUUID();
  const payload = {
    id, principle: shared.principle || shared.solution, solution: shared.solution,
    tier: 0, confidence: Math.min(shared.confidence || 0.7, 0.8), // imported = slightly lower confidence
    hitCount: 0, confirmedAt: [],
    domain: shared.domain || null,
    createdAt: new Date().toISOString(), createdFrom: 'imported',
    importedFrom: shared.sharedBy || 'unknown',
  };
  await upsertEntry('experience-principles', id, vector, payload);
  activityLog({ op: 'principle-import', id: id.slice(0, 8), from: shared.sharedBy || 'unknown' });
  return { id, principle: payload.principle };
}

// --- Qdrant multi-user migration ---

async function migrateQdrantUserTags() {
  // Bypass checkQdrant() cache — migration runs early, cache may not be warm yet.
  // Direct probe instead.
  try {
    const apiKey = getQdrantApiKey();
    const probe = await fetch(`${getQdrantBase()}/collections`, {
      headers: apiKey ? { 'api-key': apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!probe.ok) return;
    setQdrantAvailable(true);
  } catch { return; }
  for (const coll of COLLECTIONS) {
    try {
      // Find points without user field
      const res = await fetch(`${getQdrantBase()}/collections/${coll.name}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ limit: 100, with_payload: true, with_vector: false, filter: { must: [{ is_empty: { key: 'user' } }] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const points = (await res.json()).result?.points || [];
      if (points.length === 0) continue;
      // Batch-set user field
      await fetch(`${getQdrantBase()}/collections/${coll.name}/points/payload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': getQdrantApiKey() },
        body: JSON.stringify({ points: points.map(p => p.id), payload: { user: getExpUser() } }),
        signal: AbortSignal.timeout(10000),
      });
      activityLog({ op: 'migrate-user-tags', collection: coll.name, tagged: points.length });
    } catch { /* best-effort */ }
  }
}

module.exports = {
  tokenizeOrganicSupportText, organicSupportText, tokenOverlapRatio,
  conditionOverlapCount, buildOrganicSupportKey, isOrganicSupportCandidate,
  findOrganicSupportCandidate, applyOrganicSupportUpdate,
  uniqueConfirmationCount, hasRepeatedSessionConfirmations,
  resetPromotionProbation, shouldPromoteBehavioralToPrinciple,
  parsePayload, clusterByCosine, sharePrinciple, importPrinciple,
  migrateQdrantUserTags, storeExperience, evolve,
  getAllEntries, upsertEntry,
  _inheritClusterScope,
};
