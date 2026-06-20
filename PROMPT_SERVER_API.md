# Prompt Server API for Claude Code Hooks

The Raspberry Pi aquarium-pi platform runs an HTTP prompt server on port `8888` (bound to
all interfaces) that allows Claude Code hooks to display confirmation dialogs on the device
and get user input back. Claude Code typically runs on your dev machine and reaches the Pi
over the LAN, so point hooks at the Pi's address — `http://raspberrypi:8888/prompt` (or
replace `raspberrypi` with your Pi's hostname/IP if different, e.g. `aquarium-pi.local`).

## Starting the Server

The prompt server starts automatically when aquarium-pi boots (in `setup()` → `promptServerStart(8888)`).

## API Endpoint

### POST `/prompt`

Display a confirmation dialog on the device and wait for the user to select an option.

**Request:**
```json
{
  "question": "Allow this code action?",
  "options": ["yes", "no", "cancel"]
}
```

**Response (200 OK):**
```json
{
  "selected": "yes"
}
```

**Timeout:** 120 seconds (returns 408 if no selection made)

## Usage from Claude Code Hooks

### Via Bash Hook

Add to `.claude/settings.json` under your hooks configuration:

```json
{
  "hooks": {
    "beforeWrite": {
      "run": "bash",
      "script": "curl -s -X POST http://raspberrypi:8888/prompt -H 'Content-Type: application/json' -d '{\"question\": \"Write to this file?\", \"options\": [\"allow\", \"deny\"]}' | jq -r '.selected' | grep -q allow"
    }
  }
}
```

If the hook returns exit code 0, the action proceeds. Exit code != 0 aborts.

### Via cURL (manual testing)

```bash
curl -X POST http://raspberrypi:8888/prompt \
  -H 'Content-Type: application/json' \
  -d '{"question": "Deploy to production?", "options": ["yes", "no"]}'
```

## User Interaction

When a prompt is active:

- **Mouse/Touch**: Click on any option button to select
- **Keyboard**:
  - **←/→ Arrow Keys**: Navigate between options
  - **Enter**: Select the highlighted option
  - **Escape**: Does NOT cancel (prompts must timeout or be selected)

The dialog displays:
- A semi-transparent overlay covering the tank
- A centered dialog box with the question
- Option buttons colored green (selected) or gray (unselected)

## Integration Notes

- The prompt server runs in a background thread and does **not block** the device's tank rendering
- While a prompt is active, the tank continues to render and animate normally
- Only user input on the prompt affects its outcome; tank controls are paused
- The server is lightweight (~500 bytes) and has minimal CPU overhead

## Example: Enable/Disable Game Mode via Hook

```bash
#!/bin/bash
# Hook that prompts before switching game modes

curl -s -X POST http://raspberrypi:8888/prompt \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Switch to Career Mode?",
    "options": ["Career", "Creative", "Cancel"]
  }' | jq -r '.selected' | {
    read response
    case "$response" in
      "Career")  exit 0 ;;
      "Creative") exit 0 ;;
      *)         exit 1 ;;
    esac
  }
```

Then use this hook to control mode switches:

```json
{
  "hooks": {
    "beforeCommand": {
      "run": "bash",
      "script": "./check_mode_confirmation.sh"
    }
  }
}
```

## Troubleshooting

- **No dialog appears**: Check that aquarium-pi compiled with socket headers (`<sys/socket.h>`, etc.) and is running on a platform that supports threads
- **Timeout (408 response)**: User didn't select within 2 minutes; your hook should treat this as a rejection
- **Port in use**: Change the port in `promptServerStart(PORT)` call in `setup()`
- **Connection refused**: aquarium-pi isn't running, or the port is wrong

## Security Notes

- The server listens on **all interfaces** (`0.0.0.0:8888`) so it's reachable over the LAN
- It accepts plain JSON; **no authentication** — only run this on a trusted home network
- Prompts are transient and not logged
- To restrict to localhost (Claude Code running on the Pi itself), change the bind address
  in `prompt_server.h` from `INADDR_ANY` back to `inet_addr("127.0.0.1")`
