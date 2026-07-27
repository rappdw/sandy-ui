This is the #1 surprise for new users: **closing the tab (or quitting VSCode) does not stop sandy.** It detaches. The container keeps running on your machine — with sandy ≥ 1.1.0 it even survives a reboot.

Stopping is explicit: use **Stop** from the Sandy tree view's right-click menu, or from the status-bar session picker.

The status bar (bottom right) always shows what's currently live, e.g. `2 sandy (1 detached)` — click it to switch tabs or re-attach.

Left something running by accident for a while? `sandy.longRunningSessionHours` (default 24h) nudges you once per window with Attach/Stop actions. Set it to `0` to disable.

[Got it](command:sandy.walkthrough.ackPersistence)
