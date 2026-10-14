import paramiko, os, sys

PI_HOST = "10.44.164.22"
PI_USER = "delta"
PI_PASS = "delta123"
REPO = r"C:\Users\kevin\Documents\delta-dashboard"

UPLOADS = [
    ("main.js", "delta-dashboard/main.js"),
    ("index.html", "delta-dashboard/index.html"),
    ("styles.css", "delta-dashboard/styles.css"),
]

print(f"[deploy] Connecting to {PI_USER}@{PI_HOST}...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(PI_HOST, username=PI_USER, password=PI_PASS, timeout=10)
print("[deploy] Connected.")

sftp = client.open_sftp()

# Ensure remote dirs exist
dirs_created = set()
for local_rel, remote_path in UPLOADS:
    local_path = os.path.join(REPO, local_rel)
    if not os.path.exists(local_path):
        print(f"  SKIP (missing locally): {local_rel}")
        continue
    full_remote = f"/home/{PI_USER}/{remote_path}"
    remote_dir = os.path.dirname(full_remote).replace("\\", "/")
    if remote_dir not in dirs_created:
        try:
            sftp.stat(remote_dir)
        except FileNotFoundError:
            # Create parent dirs recursively
            parts = remote_dir.split("/")
            cur = ""
            for p in parts:
                if not p:
                    cur = "/"
                    continue
                cur = cur + "/" + p if cur != "/" else "/" + p
                if cur in dirs_created:
                    continue
                try:
                    sftp.stat(cur)
                except FileNotFoundError:
                    print(f"  MKDIR {cur}")
                    sftp.mkdir(cur)
                dirs_created.add(cur)
        dirs_created.add(remote_dir)
    print(f"  PUT {local_rel} -> {full_remote}")
    sftp.put(local_path, full_remote)

sftp.close()
print("[deploy] All files uploaded.")

print("[deploy] Restarting delta-server...")
client.exec_command("systemctl --user restart delta-server.service", timeout=10)
print("[deploy] Done. Frontend is live.")
client.close()
print("[deploy] Done. Pi is rebooting.")
