Sandy is a CLI that runs your coding agent (Claude Code, Gemini CLI, Codex CLI, OpenCode) inside a locked-down Docker container — read/write limited to your project directory, public-internet-only networking, no Docker socket access.

Install it:

```bash
curl -fsSL https://raw.githubusercontent.com/rappdw/sandy/main/install.sh | bash
```

Already installed? This step checks itself — it ticks off automatically once `sandy` is found on your `PATH` (or at `sandy.binaryPath` if you've set that setting). No need to reload the window; the check re-runs live.

Not sure your machine is ready? Sandy ships a doctor script that never installs anything, just reports what's missing:

```bash
curl -fsSL https://raw.githubusercontent.com/rappdw/sandy/main/doctor.sh | bash
```
