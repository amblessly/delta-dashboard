"""
Quick Pi setup / restore script.
Deploys correct labwc config, udev rules, and touch calibration.
Run after fresh OS install or when touch/display breaks.
"""
import paramiko
import time
import os

PI_IP = '192.168.137.228'
PI_USER = 'delta'
PI_PASS = 'delta123'
BASE = os.path.dirname(os.path.abspath(__file__))


def run(c, cmd, timeout=10):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    return out.strip(), err.strip()


def upload(c, local_path, remote_path):
    sftp = c.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(PI_IP, username=PI_USER, password=PI_PASS, timeout=10)
    print(f"Connected to {PI_IP}")

    # 1. Deploy labwc rc.xml
    print("Deploying labwc rc.xml...")
    upload(c, os.path.join(BASE, 'labwc-rc.xml'),
           '/home/delta/.config/labwc/rc.xml')
    run(c, 'chown delta:delta /home/delta/.config/labwc/rc.xml')
    print("  OK")

    # 2. Deploy autostart
    print("Deploying labwc autostart...")
    upload(c, os.path.join(BASE, 'labwc-autostart'),
           '/home/delta/.config/labwc/autostart')
    run(c, 'chmod +x /home/delta/.config/labwc/autostart')
    run(c, 'chown delta:delta /home/delta/.config/labwc/autostart')
    print("  OK")

    # 3. Deploy udev rule
    print("Deploying udev touch rule...")
    upload(c, os.path.join(BASE, '99-touch-calibration.rules'),
           '/etc/udev/rules.d/99-touch-calibration.rules')
    run(c, 'sudo udevadm control --reload-rules')
    print("  OK")

    # 4. Unbind/rebind touch device to apply udev rule
    print("Rebinding touch device...")
    run(c, 'echo "1-1.3" | sudo tee /sys/bus/usb/drivers/usb/unbind')
    time.sleep(2)
    run(c, 'echo "1-1.3" | sudo tee /sys/bus/usb/drivers/usb/bind')
    time.sleep(3)

    # Verify calibration
    out, _ = run(c, 'sudo libinput list-devices 2>&1 | grep -A 15 USB2IIC_CTP | grep Calibration')
    print(f"  Touch calibration: {out}")

    # 5. Apply display rotation (if labwc is running)
    out, _ = run(c, 'pgrep -u delta labwc')
    if out:
        print("Applying display rotation...")
        run(c, 'sudo -u delta env XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --transform 90')
        print("  OK")
    else:
        print("  labwc not running, rotation will apply on boot via autostart")

    # 6. Verify services
    print("\nService status:")
    for svc in ['delta-server', 'delta-thermal', 'delta-kiosk']:
        out, _ = run(c, f'systemctl --user status {svc} --no-pager 2>&1 | head -4')
        for line in out.split('\n'):
            if 'Active:' in line:
                print(f"  {svc}: {line.strip()}")

    c.close()
    print("\nDone!")


if __name__ == '__main__':
    main()
