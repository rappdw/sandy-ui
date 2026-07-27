Sandy builds and runs its container through Docker, so it needs a Docker-compatible runtime installed **and running**. This extension doesn't require Docker itself — only sandy does.

Any of these work:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Rancher Desktop](https://rancherdesktop.io/)
- [Colima](https://github.com/abiosoft/colima)
- [OrbStack](https://orbstack.dev/)

This step ticks off automatically once Sandy's tree view has polled `sandy --print-state` and it reports Docker as reachable — open the **Sandy** activity-bar view to trigger a poll if this is still unchecked.
