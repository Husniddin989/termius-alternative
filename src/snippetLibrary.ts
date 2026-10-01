import type { Snippet } from "./api";

/**
 * Built-in commands added to Snippets on first start (and on demand from
 * Settings). `<placeholder>` parts are meant to be edited, so snippets that
 * contain one are typed into the terminal without pressing Enter.
 */
const LIBRARY: Record<string, [name: string, command: string][]> = {
  System: [
    ["OS and kernel version", "cat /etc/os-release && uname -a"],
    ["Uptime and load", "uptime"],
    ["Memory usage", "free -h"],
    ["CPU info", "lscpu"],
    ["Hostname and IPs", "hostnamectl; hostname -I"],
    ["Who is logged in", "w"],
    ["Last logins", "last -n 20"],
    ["Reboot history", "last reboot | head"],
    ["System time and timezone", "timedatectl"],
    ["Kernel messages (errors)", "dmesg -T --level=err,warn | tail -50"],
  ],
  "Disk & Files": [
    ["Disk usage by filesystem", "df -h"],
    ["Biggest folders here", "du -h --max-depth=1 . 2>/dev/null | sort -rh | head -20"],
    ["Biggest files under /", "find / -xdev -type f -size +100M -exec ls -lh {} + 2>/dev/null | sort -k5 -rh | head -20"],
    ["Inode usage", "df -i"],
    ["Block devices", "lsblk -f"],
    ["Find file by name", "find / -name '<name>' 2>/dev/null"],
    ["Search text in files", "grep -rn '<text>' <dir>"],
    ["Files changed in last 24h", "find . -type f -mtime -1 -printf '%TY-%Tm-%Td %TH:%TM %p\\n' | sort -r | head -50"],
    ["Directory tree (2 levels)", "find . -maxdepth 2 -not -path '*/.*' | sort"],
    ["Clean apt cache", "sudo apt-get clean && sudo apt-get autoremove -y"],
  ],
  Processes: [
    ["Top CPU processes", "ps aux --sort=-%cpu | head -15"],
    ["Top memory processes", "ps aux --sort=-%mem | head -15"],
    ["Process tree", "ps -ejH | less"],
    ["Find process by name", "pgrep -af '<name>'"],
    ["Kill process by PID", "kill <pid>"],
    ["Force kill by name", "pkill -9 -f '<name>'"],
    ["Open files of a process", "lsof -p <pid>"],
    ["Interactive monitor", "htop || top"],
  ],
  Network: [
    ["Listening ports", "sudo ss -tulpn"],
    ["Established connections", "ss -tnp state established"],
    ["Who uses a port", "sudo lsof -i :<port>"],
    ["IP addresses", "ip -br addr"],
    ["Routing table", "ip route"],
    ["Public IP", "curl -s https://ifconfig.me; echo"],
    ["DNS lookup", "dig +short <domain>"],
    ["Test TCP port", "nc -zv <host> <port>"],
    ["HTTP headers of a URL", "curl -sI <url>"],
    ["Trace route", "traceroute <host>"],
    ["Bandwidth per connection", "sudo iftop -P"],
    ["Firewall status (ufw)", "sudo ufw status verbose"],
    ["Firewall rules (iptables)", "sudo iptables -L -n -v --line-numbers"],
  ],
  "Users & Permissions": [
    ["Current user and groups", "id"],
    ["List users with a shell", "grep -E '/(ba|z|fi)?sh$' /etc/passwd | cut -d: -f1"],
    ["Add user", "sudo adduser <user>"],
    ["Add user to sudo group", "sudo usermod -aG sudo <user>"],
    ["Change owner recursively", "sudo chown -R <user>:<group> <path>"],
    ["Fix SSH key permissions", "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"],
    ["Show authorized keys", "cat ~/.ssh/authorized_keys"],
    ["Failed SSH logins", "sudo grep 'Failed password' /var/log/auth.log | tail -20"],
  ],
  Packages: [
    ["Update package lists (apt)", "sudo apt update"],
    ["Upgrade packages (apt)", "sudo apt update && sudo apt upgrade -y"],
    ["Install package (apt)", "sudo apt install -y <package>"],
    ["Search package (apt)", "apt search <package>"],
    ["Upgradable packages (apt)", "apt list --upgradable"],
    ["Update packages (dnf)", "sudo dnf upgrade -y"],
    ["Install package (dnf)", "sudo dnf install -y <package>"],
    ["Install package (apk)", "sudo apk add <package>"],
  ],
  Services: [
    ["Running services", "systemctl list-units --type=service --state=running"],
    ["Failed services", "systemctl --failed"],
    ["Service status", "systemctl status <service>"],
    ["Restart service", "sudo systemctl restart <service>"],
    ["Enable and start service", "sudo systemctl enable --now <service>"],
    ["Service logs (follow)", "journalctl -u <service> -f"],
    ["Service logs (last hour)", "journalctl -u <service> --since '1 hour ago' --no-pager"],
    ["Cron jobs of current user", "crontab -l"],
    ["Timers", "systemctl list-timers"],
  ],
  Logs: [
    ["System log (follow)", "sudo journalctl -f"],
    ["Errors since boot", "journalctl -p err -b --no-pager | tail -50"],
    ["Syslog tail", "sudo tail -f /var/log/syslog"],
    ["Journal disk usage", "journalctl --disk-usage"],
    ["Shrink journal to 500M", "sudo journalctl --vacuum-size=500M"],
    ["Nginx access log", "sudo tail -f /var/log/nginx/access.log"],
    ["Nginx error log", "sudo tail -f /var/log/nginx/error.log"],
  ],
  Docker: [
    ["Running containers", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"],
    ["All containers", "docker ps -a"],
    ["Container resource usage", "docker stats --no-stream"],
    ["Container logs (follow)", "docker logs -f --tail 100 <container>"],
    ["Shell into container", "docker exec -it <container> sh"],
    ["Restart container", "docker restart <container>"],
    ["Images", "docker images"],
    ["Disk usage", "docker system df"],
    ["Remove unused data", "docker system prune -f"],
    ["Inspect container IP", "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <container>"],
  ],
  "Docker Compose": [
    ["Services status", "docker compose ps"],
    ["Start in background", "docker compose up -d"],
    ["Pull and recreate", "docker compose pull && docker compose up -d"],
    ["Logs (follow)", "docker compose logs -f --tail 100"],
    ["Restart a service", "docker compose restart <service>"],
    ["Stop and remove", "docker compose down"],
  ],
  Git: [
    ["Status", "git status -sb"],
    ["Pretty log", "git log --oneline --graph --decorate -20"],
    ["Pull with rebase", "git pull --rebase"],
    ["Branches by last commit", "git branch --sort=-committerdate"],
    ["Discard local changes", "git checkout -- . && git clean -fd"],
    ["Undo last commit (keep changes)", "git reset --soft HEAD~1"],
    ["Stash changes", "git stash push -m '<message>'"],
    ["Show remote URLs", "git remote -v"],
  ],
  Nginx: [
    ["Test config", "sudo nginx -t"],
    ["Reload", "sudo nginx -t && sudo systemctl reload nginx"],
    ["Enabled sites", "ls -l /etc/nginx/sites-enabled/"],
    ["Full effective config", "sudo nginx -T | less"],
  ],
  Databases: [
    ["PostgreSQL shell", "sudo -u postgres psql"],
    ["PostgreSQL databases", "sudo -u postgres psql -c '\\l'"],
    ["PostgreSQL active queries", "sudo -u postgres psql -c \"SELECT pid, state, now() - query_start AS age, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC;\""],
    ["PostgreSQL dump", "sudo -u postgres pg_dump <db> | gzip > <db>-$(date +%F).sql.gz"],
    ["MySQL shell", "sudo mysql"],
    ["Redis ping", "redis-cli ping"],
    ["Redis memory info", "redis-cli info memory"],
  ],
  Kubernetes: [
    ["Pods in all namespaces", "kubectl get pods -A"],
    ["Pods not running", "kubectl get pods -A --field-selector=status.phase!=Running"],
    ["Pod logs (follow)", "kubectl logs -f <pod> -n <namespace>"],
    ["Describe pod", "kubectl describe pod <pod> -n <namespace>"],
    ["Shell into pod", "kubectl exec -it <pod> -n <namespace> -- sh"],
    ["Node resource usage", "kubectl top nodes"],
    ["Recent events", "kubectl get events -A --sort-by=.lastTimestamp | tail -30"],
    ["Restart deployment", "kubectl rollout restart deployment/<name> -n <namespace>"],
  ],
  "SSL & Security": [
    ["Certificate expiry of a site", "echo | openssl s_client -servername <domain> -connect <domain>:443 2>/dev/null | openssl x509 -noout -dates"],
    ["Certbot certificates", "sudo certbot certificates"],
    ["Renew certificates (dry run)", "sudo certbot renew --dry-run"],
    ["Fail2ban status", "sudo fail2ban-client status sshd"],
    ["Generate SSH key", "ssh-keygen -t ed25519 -C '<email>'"],
    ["Random password", "openssl rand -base64 24"],
  ],
  Archives: [
    ["Create tar.gz", "tar -czf <archive>.tar.gz <path>"],
    ["Extract tar.gz", "tar -xzf <archive>.tar.gz"],
    ["List tar.gz contents", "tar -tzf <archive>.tar.gz | less"],
    ["Zip a folder", "zip -r <archive>.zip <folder>"],
    ["Unzip", "unzip <archive>.zip"],
  ],
};

/** Stable ids, so the same built-in snippet is one record on every synced device. */
function libraryId(category: string, name: string) {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `lib-${slug(category)}-${slug(name)}`;
}

export const LIBRARY_SNIPPETS: Snippet[] = Object.entries(LIBRARY).flatMap(([category, items]) =>
  items.map(([name, command]) => ({ id: libraryId(category, name), name, command, category })),
);

/** True when the command has `<placeholder>` parts the user should fill in first. */
export const hasPlaceholder = (command: string) => /<[a-z][a-z0-9_ -]*>/i.test(command);
