# The attack lab's target: an SSH server with CrowdSec and Fail2ban, the way
# a small internet-facing VPS is often set up. For GRIDCITY's security tests
# only (scripts/security-lab.mjs); never expose it beyond this machine.
FROM debian:bookworm-20261027-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server rsyslog fail2ban crowdsec iptables netcat-openbsd sudo procps iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# rsyslog in a container: no kernel log, auth messages to /var/log/auth.log.
RUN sed -i '/imklog/s/^/#/' /etc/rsyslog.conf

# ops: the account GRIDCITY signs in with (key only). It may read the auth log
# (adm) and run only the two read commands GRIDCITY needs as root.
# test: a careless account with a guessable password, for the attackers.
RUN useradd -m -s /bin/bash -G adm ops \
 && passwd -l ops \
 && useradd -m -s /bin/bash test \
 && echo 'test:password123' | chpasswd \
 && printf 'ops ALL=(root) NOPASSWD: /usr/bin/cscli, /usr/bin/fail2ban-client\n' > /etc/sudoers.d/gridcity \
 && chmod 440 /etc/sudoers.d/gridcity

# The lab attacks from private addresses, which CrowdSec ignores by default.
RUN cscli parsers remove crowdsecurity/whitelists || true

COPY sshd-lab.conf /etc/ssh/sshd_config.d/lab.conf
COPY jail.local /etc/fail2ban/jail.local
COPY acquis.yaml /etc/crowdsec/acquis.yaml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
