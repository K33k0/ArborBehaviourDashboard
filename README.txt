Orme Academy Dashboard — Python standard library only

1. Open config.json and replace the example feed URLs and the Basic authorisation value.
2. If a feed has its own authorisation, add an "authorization" value inside that feed's object.
3. Run: python server.py
4. Open http://127.0.0.1:3000 (or your configured host and port).

Refresh: At :15 and :45, the first browser request to each endpoint triggers a fetch.
The server keeps the last successful feed result if a fetch fails and retries
on the next browser poll after a 60-second cooldown.
All four feeds are cached separately, and browsers receive only aggregated results.

On Windows, run.bat starts the server and opens the configured address.
The browser remembers the last manually selected leaderboard, auto-rotation,
and the rotation interval. Fullscreen uses the available display area. The
boards scale down on shorter displays to keep all forms visible together.

The small signed numbers beside form scores show score movement since the
previous weekday. Attendance movement is in percentage points (pp). The
dashboard uses the last fresh result seen by this browser on each weekday.
Movement appears when that browser has a result for both days.

Security: config.json contains credentials. Keep it on a trusted machine, restrict file access, do not commit or share it. The server does not serve config.json.
The default 127.0.0.1 host is local-only. Do not change to 0.0.0.0 without appropriately securing network access and reviewing the data-sharing policy.

The separate config.example.json is a reusable placeholder.
