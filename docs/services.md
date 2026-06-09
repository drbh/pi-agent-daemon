# Running as a Service

`pi-agent-daemon` can run under systemd or launchd as a normal long-running process. The
daemon does not need socket activation; service managers only need to start it with a
stable socket path and working directory.

Use `--cwd` in service definitions so default sessions have a predictable working
directory and resource lookup base.

## systemd User Service

Use this on developer machines where the daemon should run as your login user.

```sh
install -D -m 0755 dist/pi-agent-daemon "$HOME/.local/bin/pi-agent-daemon"
mkdir -p "$HOME/.config/systemd/user"
cp services/systemd/pi-agent-daemon.user.service \
  "$HOME/.config/systemd/user/pi-agent-daemon.service"
systemctl --user daemon-reload
systemctl --user enable --now pi-agent-daemon
systemctl --user status pi-agent-daemon
```

The default user-service socket path is:

```sh
"$XDG_RUNTIME_DIR/pi-agent-daemon.sock"
```

Health check:

```sh
pi-agent-daemon health --socket "$XDG_RUNTIME_DIR/pi-agent-daemon.sock"
```

Optional environment file:

```sh
mkdir -p "$HOME/.config/pi-agent-daemon"
$EDITOR "$HOME/.config/pi-agent-daemon/env"
```

Example:

```sh
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

Logs:

```sh
journalctl --user -u pi-agent-daemon -f
```

## systemd System Service

Use this when the daemon should run as a dedicated service user.

```sh
sudo useradd --system --home /var/lib/pi-agent-daemon --create-home pi-agent
sudo install -D -m 0755 dist/pi-agent-daemon /usr/local/bin/pi-agent-daemon
sudo install -D -m 0644 services/systemd/pi-agent-daemon.service \
  /etc/systemd/system/pi-agent-daemon.service
sudo mkdir -p /etc/pi-agent-daemon
sudo touch /etc/pi-agent-daemon/env
sudo systemctl daemon-reload
sudo systemctl enable --now pi-agent-daemon
sudo systemctl status pi-agent-daemon
```

The default system-service socket path is:

```sh
/run/pi-agent-daemon/pi-agent-daemon.sock
```

Health check:

```sh
pi-agent-daemon health --socket /run/pi-agent-daemon/pi-agent-daemon.sock
```

Logs:

```sh
journalctl -u pi-agent-daemon -f
```

## launchd User Agent

Use this on macOS. Edit the plist before loading it:

- Replace `/usr/local/bin/pi-agent-daemon` if the binary is elsewhere.
- Replace `/Users/YOUR_USER` with your home directory.
- Change the socket/log paths if needed.

```sh
mkdir -p "$HOME/Library/LaunchAgents"
cp services/launchd/com.pi-agent.daemon.plist \
  "$HOME/Library/LaunchAgents/com.pi-agent.daemon.plist"
$EDITOR "$HOME/Library/LaunchAgents/com.pi-agent.daemon.plist"
launchctl load "$HOME/Library/LaunchAgents/com.pi-agent.daemon.plist"
launchctl start com.pi-agent.daemon
```

The template socket path is:

```sh
/tmp/pi-agent-daemon.sock
```

Health check:

```sh
pi-agent-daemon health --socket /tmp/pi-agent-daemon.sock
```

Stop and unload:

```sh
launchctl stop com.pi-agent.daemon
launchctl unload "$HOME/Library/LaunchAgents/com.pi-agent.daemon.plist"
```

Logs:

```sh
tail -f /tmp/pi-agent-daemon.err.log
```
