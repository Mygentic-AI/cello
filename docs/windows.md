# Windows

- Your data is in `%USERPROFILE%\.cello`. The daemon listens on a named pipe, `\\.\pipe\cello-<12 hex>-daemon`, not on a socket file. The 12 characters come from the data folder, so each `CELLO_HOME` gets its own daemon. Other accounts on the machine can't send the daemon anything. Before anything is sent, `cello`, the MCP server and the Hermes bridge each check that whatever holds the pipe knows a key only your account can read, so another account can't pose as the daemon. If one ever fails that check, you see `daemon_unverified` and nothing is sent.
- The daemon runs hidden, with no console window. It doesn't start again by itself after a reboot or a sign-out, so run `cello login` again then.
- `cello screener install` runs `npm` itself. It adds `allow-scripts=onnxruntime-node,protobufjs` to the `.npmrc` in its runtime folder, so npm 11 fetches the model's native runtime. Anything else in that file is kept.
- A sandbox that blocks named pipes stops everything from reaching the daemon (`EPERM`). Run `cello` outside it.
