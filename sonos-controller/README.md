# Sonos Online

A self-hosted web controller for Sonos speakers. Access and control your Sonos system from any browser, including remotely over HTTPS.

![Sonos Online](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- 🔊 Control all your Sonos speakers from any browser
- 🌐 Remote access over HTTPS (via reverse proxy)
- 🎵 Browse and play from your local music library
- 📻 Search and play TuneIn radio stations
- 🏠 Room grouping and Play Everywhere
- 🌙 Dark and light theme
- 📱 Mobile-friendly responsive UI
- 🔒 Session-based authentication

## What Works

- Play / pause / skip / previous
- Volume control and mute
- Room grouping (including Play Everywhere)
- Favourites display (see note below)
- Queue display
- Album art
- TuneIn radio search

## Limitation Note

Sonos favourites that use streaming services (Spotify, BBC Sounds, Apple Music etc.) or music library playlists require Sonos account tokens that are only maintained by the official Sonos app. You can start them playing in the official app first and then use Sonos Online for volume, grouping and transport control.

TuneIn radio stations added as favourites work fine.

## Requirements

- Node.js 18 or later
- Sonos speakers on the same local network as the server

## Installation (Windows)

1. Extract to `C:\sonos-online`
2. Open CMD in `C:\sonos-online\backend` and run:
   ```
   npm install
   ```
3. Start the server:
   ```
   node server.js
   ```
4. Open http://localhost:3000
5. Default credentials: username `admin`, password `sonos`

## Running as a Windows Service (Task Scheduler)

1. Open Task Scheduler
2. Create Task (not Basic Task)
3. General: "Run whether user is logged on or not", "Run with highest privileges"
4. Trigger: At startup
5. Action: Program `C:\Program Files\nodejs\node.exe`, Arguments `server.js`, Start in `C:\sonos-online\backend`
6. Settings: Untick "Stop the task if it runs longer than..."

## Changing Your Password

```
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('YOURNEWPASSWORD').digest('hex'))"
```

Edit `backend/config.json`:
```json
{
  "username": "yourusername",
  "passwordHash": "paste-hash-here"
}
```

## Remote Access (HTTPS)

Use a reverse proxy such as Nginx Proxy Manager pointing to port 3000. Recommended Nginx settings:

```nginx
proxy_read_timeout 60s;
proxy_connect_timeout 10s;
proxy_send_timeout 60s;
```

Enable WebSocket support in your proxy for real-time updates.

## Docker

```
docker-compose up -d
```

## License

MIT
