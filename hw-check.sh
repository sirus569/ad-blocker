#!/usr/bin/env bash
# Collects the hardware facts that matter for running two Chromes (TV + GPU-off
# detector) and server.py on an Ubuntu laptop. Read-only; writes hw-<hostname>.txt.
# Run: bash hw-check.sh        (sudo is only used for RAM details, and you can skip it)

out="hw-$(hostname).txt"
{
echo "=== OS ==="
lsb_release -ds 2>/dev/null; uname -r
echo "session: ${XDG_SESSION_TYPE:-unknown}  desktop: ${XDG_CURRENT_DESKTOP:-unknown}"

echo; echo "=== CPU ==="
lscpu | grep -E "Model name|^CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket|CPU max MHz"
echo "flags: $(grep -oE '\b(avx2|avx512f|sse4_2|aes)\b' /proc/cpuinfo | sort -u | tr '\n' ' ')"

echo; echo "=== Memory ==="
free -h
echo "-- RAM modules (asks for your password; to skip, press Enter 3 times):"
sudo dmidecode -t memory 2>/dev/null | grep -E "^\s+(Size|Type|Speed|Configured Memory Speed):" | grep -v "No Module" | sort | uniq -c

echo; echo "=== GPU ==="
lspci -nn | grep -Ei "vga|3d|display"
if command -v vainfo >/dev/null; then
  echo "-- VA-API hardware decode profiles:"
  vainfo 2>/dev/null | grep -E "Driver version|VLD" | grep -Ei "driver|H264|VP9|AV1|HEVC"
else
  echo "vainfo not installed (sudo apt install vainfo) - shows hardware VP9/AV1 decode"
fi

echo; echo "=== Displays ==="
command -v xrandr >/dev/null && xrandr 2>/dev/null | grep -E " connected|\*"

echo; echo "=== Disk ==="
lsblk -d -o NAME,SIZE,ROTA,MODEL | grep -v loop
df -h / | tail -1

echo; echo "=== Chrome ==="
(google-chrome --version || google-chrome-stable --version || chromium --version) 2>/dev/null || echo "no Chrome found"

echo; echo "=== Thermals / battery ==="
command -v sensors >/dev/null && sensors 2>/dev/null | grep -Ei "package|core 0|tctl|temp1" | head -4
upower -i "$(upower -e | grep -m1 BAT)" 2>/dev/null | grep -E "capacity|energy-full:|energy-full-design"

echo; echo "=== CPU benchmark (about 20 s) ==="
echo "-- single core (sha256, 16KB blocks):"
openssl speed -seconds 5 -bytes 16384 sha256 2>/dev/null | tail -1
echo "-- all cores:"
openssl speed -seconds 5 -bytes 16384 -multi "$(nproc)" sha256 2>/dev/null | tail -1
} 2>&1 | tee "$out"
echo; echo "Saved to $out - paste its contents back."
