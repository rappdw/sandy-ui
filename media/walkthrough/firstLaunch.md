**Sandy: Launch** opens sandy as a full editor tab against your currently open workspace folder — not a bottom-panel terminal, so it gets full real estate and can split alongside your source files.

The first launch builds sandy's container images, which can take several minutes (sandy waits up to 10 minutes for a session to come up). You'll watch the build live in the tab. Later launches attach in seconds.

If the project asks for something sandy needs your OK for — privileged settings in its `.sandy/config`, or its own `.sandy/Dockerfile` — sandy-ui first shows a read-only preview of exactly what's being asked, values included. Then sandy asks you in the terminal and remembers your answer.

No workspace open yet? You'll be prompted to pick a folder first — sandy never falls back to your home directory.

[Launch Sandy](command:sandy.launch)
