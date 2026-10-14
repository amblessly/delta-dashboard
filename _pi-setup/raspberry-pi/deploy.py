import paramiko
import os
import time

base = r'C:\Users\kevin\Documents\delta-dashboard'
REMOTE = '/home/delta/delta-dashboard'

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('192.168.137.228', username='delta', password='delta123', timeout=10)

sftp = c.open_sftp()

# Upload frontend files + server.js
upload = [
    ('index.html', 'index.html'),
    ('styles.css', 'styles.css'),
    ('main.js', 'main.js'),
    ('api-client.js', 'api-client.js'),
    ('thermal-panel.js', 'thermal-panel.js'),
    ('onscreen-keyboard.js', 'onscreen-keyboard.js'),
    ('server/server.js', 'server/server.js'),
]
for local_rel, remote_rel in upload:
    lp = os.path.join(base, local_rel)
    if os.path.exists(lp):
        sftp.put(lp, f'{REMOTE}/{remote_rel}')
        print(f'  uploaded {remote_rel}')
    else:
        print(f'  SKIP {local_rel}')

# Upload font
fp = os.path.join(base, 'fonts', 'nunito-latin.woff2')
if os.path.exists(fp):
    sftp.put(fp, f'{REMOTE}/fonts/nunito-latin.woff2')
    print('  uploaded fonts/nunito-latin.woff2')

# Create systemd user services
services = {
    'delta-server.service': '''[Unit]
Description=Project DELTA Dashboard Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/delta/delta-dashboard/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
''',
    'delta-thermal.service': '''[Unit]
Description=Project DELTA MLX90640 Thermal Reader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/delta/delta-dashboard/raspberry-pi/mlx90640_reader.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
''',
    'delta-kiosk.service': '''[Unit]
Description=Project DELTA Chromium Kiosk
After=graphical-session.target delta-server.service
Wants=graphical-session.target

[Service]
Type=simple
ExecStartPre=/bin/bash -c 'sleep 3'
ExecStart=/usr/bin/chromium-browser --noerrdialogs --disable-infobars --kiosk --ozone-platform=x11 --no-first-run --disable-features=TranslateUI --disable-session-crashed-bubble --disable-restore-session-state --app=http://localhost:8000
Restart=always
RestartSec=10
Environment=DISPLAY=:0

[Install]
WantedBy=default.target
''',
}

for name, content in services.items():
    path = f'/home/delta/.config/systemd/user/{name}'
    with sftp.open(path, 'w') as f:
        f.write(content)
    print(f'  wrote {name}')

sftp.close()
print('Files deployed.')

# Enable and start services
cmds = [
    'systemctl --user daemon-reload',
    'systemctl --user enable delta-server delta-thermal delta-kiosk',
    'systemctl --user stop delta-server delta-thermal delta-kiosk 2>/dev/null; true',
    'systemctl --user start delta-server',
]
for cmd in cmds:
    stdin, stdout, stderr = c.exec_command(cmd, timeout=15)
    stdout.read()

time.sleep(3)

stdin, stdout, stderr = c.exec_command('systemctl --user start delta-thermal', timeout=10)
stdout.read()

time.sleep(1)

stdin, stdout, stderr = c.exec_command('systemctl --user start delta-kiosk', timeout=10)
stdout.read()

time.sleep(2)

stdin, stdout, stderr = c.exec_command('systemctl --user status delta-server --no-pager 2>&1; echo ===; systemctl --user status delta-thermal --no-pager 2>&1; echo ===; systemctl --user status delta-kiosk --no-pager 2>&1', timeout=10)
print(stdout.read().decode('utf-8', errors='replace'))

c.close()
print('Done!')
