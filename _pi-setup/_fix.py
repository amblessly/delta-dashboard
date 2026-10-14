import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('192.168.137.228', username='delta', password='delta123', timeout=10)

# Check JS syntax via node
stdin, stdout, stderr = c.exec_command(
    "node -c /home/delta/delta-dashboard/main.js",
    timeout=5
)
out = stdout.read().decode('utf-8', 'replace').strip()
err = stderr.read().decode('utf-8', 'replace').strip()
print("STDOUT:", out)
print("STDERR:", err)

# Check file served by browser has no-cache
stdin, stdout, stderr = c.exec_command(
    "curl -sI http://localhost:8000/main.js 2>&1 | head -10",
    timeout=5
)
print("HEADERS:", stdout.read().decode('utf-8', 'replace').strip())

c.close()
