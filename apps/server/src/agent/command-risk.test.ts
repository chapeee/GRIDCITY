import { describe, expect, it } from 'vitest';
import { commandRisk } from './command-risk';

describe('commandRisk', () => {
  it.each([
    ['rm -rf /var/www/old', 'deletes files'],
    ['sudo rm /etc/nginx/sites-enabled/default', 'deletes files'],
    ["sudo sh -c 'cd /tmp && rm -f *.log'", 'deletes files'],
    ['find /var/log -name "*.gz" -delete', 'deletes files'],
    ['find . -type f -exec rm {} +', 'deletes files'],
    ['sudo mkfs.ext4 /dev/sdb1', 'wipes or repartitions a disk'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'writes raw data to a disk or file'],
    ['truncate -s 0 /var/log/syslog', 'empties a file'],
    ['mysql -e "DROP DATABASE shop"', 'deletes database data'],
    ["psql -c 'delete from users where id = 4'", 'deletes database data'],
    ['redis-cli FLUSHALL', 'deletes database data'],
    ['docker rm -f web', 'removes containers, images or volumes'],
    ['docker system prune -af', 'removes containers, images or volumes'],
    ['docker compose -f prod.yml down -v', 'removes containers, images or volumes'],
    ['kubectl -n prod delete pod api-1', 'deletes cluster resources'],
    ['sudo apt-get -y purge nginx', 'uninstalls packages'],
    ['sudo dnf remove httpd', 'uninstalls packages'],
    ['sudo userdel bob', 'deletes users or scheduled jobs'],
    ['crontab -r', 'deletes users or scheduled jobs'],
    ['sudo reboot', 'reboots or shuts down the server'],
    ['sudo shutdown -h now', 'reboots or shuts down the server'],
    ['sudo systemctl stop nginx', 'stops or disables a service'],
    ['sudo systemctl disable --now mysql', 'stops or disables a service'],
    ['kill -9 1234', 'kills processes'],
    ['sudo iptables -F', 'clears firewall rules'],
    ['git reset --hard HEAD~3', 'discards git history or files'],
    ['git push origin main --force', 'discards git history or files'],
    ['aws s3 rm s3://bucket --recursive', 'deletes cloud resources'],
    ['aws ec2 terminate-instances --instance-ids i-1', 'deletes cloud resources'],
    ['terraform destroy -auto-approve', 'deletes cloud resources'],
    ['sudo chmod -R 777 /', 'changes ownership or permissions of the whole system'],
    ['echo hello > /etc/motd', 'overwrites a file'],
  ])('flags %s', (command, why) => {
    expect(commandRisk(command)).toBe(why);
  });

  it.each([
    'df -h',
    'uptime && free -m',
    'sudo systemctl status nginx --no-pager',
    'sudo systemctl restart nginx',
    'journalctl -u nginx -n 50 --no-pager 2>&1',
    'cat /var/log/syslog | tail -n 100',
    'ls -la /var/www > /dev/null',
    "awk '$5 > 80 {print $1}' /tmp/usage",
    'echo started >> /var/log/deploy.log',
    'docker ps --format "{{.Names}}"',
    'docker run --rm alpine echo ok',
    'docker logs --tail 50 web',
    'sudo apt-get update && sudo apt-get -y upgrade',
    'git pull --ff-only',
    'kubectl get pods -A',
    'mysql -e "SELECT COUNT(*) FROM orders"',
    'grep -r "error" /var/log/nginx/',
    'ps aux --sort=-%mem | head',
    'npm install',
  ])('lets %s run', (command) => {
    expect(commandRisk(command)).toBeNull();
  });
});
