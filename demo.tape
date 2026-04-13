# Experience Engine Demo — VHS recording script
# Install: go install github.com/charmbracelet/vhs@latest
# Run:     vhs demo.tape
# Output:  demo.gif (embed in README)

Output demo.gif

Set FontSize 14
Set Width 1000
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

# Title
Type "# Experience Engine — AI agents that learn from mistakes"
Enter
Sleep 1s

# Start server
Type "node server.js &"
Enter
Sleep 2s

# Health check
Type "echo '--- Health Check ---'"
Enter
Type "curl -s localhost:8082/health | jq ."
Enter
Sleep 3s

# Intercept — the money shot
Type "echo '--- Agent about to write DbContext singleton ---'"
Enter
Type "curl -s localhost:8082/api/intercept -d '{\"toolName\":\"Write\",\"toolInput\":{\"file_path\":\"src/Startup.cs\"}}' | jq ."
Enter
Sleep 4s

# Stats
Type "echo '--- How is the engine performing? ---'"
Enter
Type "curl -s localhost:8082/api/stats?since=30d | jq '{suggestions,totalIntercepts,totalMistakes,promoted,abstracted}'"
Enter
Sleep 3s

# Evolve
Type "echo '--- Trigger evolution: cluster → abstract → principles ---'"
Enter
Type "curl -s -X POST localhost:8082/api/evolve | jq ."
Enter
Sleep 3s

# Graph
Type "echo '--- Experience Graph: how knowledge connects ---'"
Enter
Type "curl -s 'localhost:8082/api/graph?id=example-uuid' | jq ."
Enter
Sleep 3s

# Timeline
Type "echo '--- Timeline: how knowledge evolved over time ---'"
Enter
Type "curl -s 'localhost:8082/api/timeline?topic=dependency+injection' | jq '.timeline[:3]'"
Enter
Sleep 3s

# Outro
Type "echo ''"
Enter
Type "echo 'Zero dependencies. Works offline. MIT license.'"
Enter
Type "echo 'github.com/muonroi/experience-engine'"
Enter
Sleep 3s
