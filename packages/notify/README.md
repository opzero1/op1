# @op1/notify

Desktop notifications plugin for OpenCode - focus detection and quiet hours.

## Features

- **Desktop Notifications** - Native macOS/Linux/Windows support
- **Focus Detection** - Suppress when app is focused
- **Quiet Hours** - Schedule notification-free periods
- **Sound Alerts** - Audio cues for events

## Installation

```bash
bun add @op1/notify
```

## Configuration

```json
{
  "plugin": ["@op1/notify"],
  "notify": {
    "enabled": true,
    "sound": true,
    "quietHours": {
      "enabled": false,
      "start": "22:00",
      "end": "08:00"
    }
  }
}
```

## Platform Support

| Platform | Method |
|----------|--------|
| macOS | osascript |
| Linux | notify-send |
| Windows | PowerShell toast |

## License

MIT
