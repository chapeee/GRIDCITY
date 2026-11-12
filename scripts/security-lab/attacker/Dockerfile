# The attack lab's attacker: password guessing (hydra) and port scans (nmap)
# against the lab target only.
FROM debian:bookworm-20261027-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends hydra nmap openssh-client \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
