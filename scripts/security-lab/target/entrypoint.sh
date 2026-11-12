#!/bin/sh
set -e
# GRIDCITY's public key (mounted) for the ops account; sshd wants strict modes.
mkdir -p /home/ops/.ssh
cp /lab/authorized_keys /home/ops/.ssh/authorized_keys
chown -R ops:ops /home/ops/.ssh
chmod 700 /home/ops/.ssh
chmod 600 /home/ops/.ssh/authorized_keys

touch /var/log/auth.log
chown root:adm /var/log/auth.log
chmod 640 /var/log/auth.log
rsyslogd
mkdir -p /run/sshd
/usr/sbin/sshd

crowdsec -c /etc/crowdsec/config.yaml >/var/log/crowdsec-run.log 2>&1 &
fail2ban-client -x start >/var/log/fail2ban-run.log 2>&1 || true

echo "security lab target ready"
exec tail -F /var/log/auth.log
