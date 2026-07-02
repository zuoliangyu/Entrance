(function() {
    'use strict';

    const AUTH_TYPE_KEY = 'key';
    const AUTH_TYPE_PASSWORD = 'password';
    const SAMPLE_PREFIX = `__ETOP_${Math.random().toString(36).slice(2, 10)}__`;
    const CPU_CARD = 'cpu';
    const MEM_CARD = 'mem';
    const DISK_CARD = 'disk';
    const NET_CARD = 'net';

    window.EntrancePlugin = {
        async mount(root, context) {
            const app = createEtopApp(root, context);
            await app.init();
        }
    };

    function createEtopApp(root, context) {
        const state = {
            context,
            hosts: [],
            user: null,
            ws: null,
            connected: false,
            selectedHost: null,
            intervalMs: 1000,
            timer: null,
            buffer: '',
            inFlight: false,
            inFlightTimer: null,
            lastCpu: null,
            lastNet: null,
            networkScale: 1024 * 1024,
            latest: {
                cpu: null,
                mem: null,
                disk: null,
                net: null
            }
        };

        const els = {
            title: root.querySelector('[data-etop-title]'),
            status: root.querySelector('[data-etop-status]'),
            hosts: root.querySelector('[data-etop-hosts]'),
            interval: root.querySelector('[data-etop-interval]'),
            refresh: root.querySelector('[data-etop-refresh]'),
            connect: root.querySelector('[data-etop-connect]'),
            empty: root.querySelector('[data-etop-empty]'),
            log: root.querySelector('[data-etop-log]'),
            rings: {
                [CPU_CARD]: root.querySelector('[data-etop-ring="cpu"]'),
                [MEM_CARD]: root.querySelector('[data-etop-ring="mem"]'),
                [DISK_CARD]: root.querySelector('[data-etop-ring="disk"]'),
                [NET_CARD]: root.querySelector('[data-etop-ring="net"]')
            },
            details: {
                [CPU_CARD]: root.querySelector('[data-etop-detail="cpu"]'),
                [MEM_CARD]: root.querySelector('[data-etop-detail="mem"]'),
                [DISK_CARD]: root.querySelector('[data-etop-detail="disk"]'),
                [NET_CARD]: root.querySelector('[data-etop-detail="net"]')
            }
        };

        return {
            async init() {
                if (els.title) els.title.textContent = context.plugin.name || 'etop';
                buildRings();
                bindEvents();
                setStatus('idle', 'Loading hosts');
                setLog('Loading saved server records from Entrance...');
                await loadHosts();
                window.addEventListener('beforeunload', cleanup);
            }
        };

        function bindEvents() {
            els.refresh?.addEventListener('click', async () => {
                await loadHosts();
            });
            els.connect?.addEventListener('click', () => {
                if (state.connected) {
                    disconnect();
                    return;
                }
                connectSelectedHost();
            });
            els.interval?.addEventListener('change', () => {
                const next = parseInt(els.interval.value, 10);
                state.intervalMs = Number.isFinite(next) && next >= 1000 ? next : 1000;
                setLog(`Sampling interval set to ${formatInterval(state.intervalMs)}.`);
                if (state.connected) {
                    startSampling();
                }
            });
        }

        async function loadHosts() {
            setControlsBusy(true);
            try {
                const verifyRes = await context.api.fetch('/api/auth/verify', { method: 'POST' });
                const verify = await verifyRes.json().catch(() => ({}));
                if (!verifyRes.ok || !verify.username) {
                    throw new Error(verify.error || 'Unable to resolve current Entrance user.');
                }
                state.user = verify.username;

                const hostsRes = await context.api.fetch(`/api/userdata/${encodeURIComponent(state.user)}/hosts`);
                const hosts = await hostsRes.json().catch(() => []);
                if (!hostsRes.ok) {
                    throw new Error(hosts.error || 'Unable to load saved hosts.');
                }

                state.hosts = Array.isArray(hosts) ? hosts : [];
                renderHosts();
                setStatus(state.connected ? 'connected' : 'idle', state.connected ? 'Connected' : 'Idle');
                setLog(state.hosts.length
                    ? `Loaded ${state.hosts.length} saved host${state.hosts.length === 1 ? '' : 's'}.`
                    : 'No saved hosts found. Add a server in the Entrance Hosts view first.');
            } catch (err) {
                setStatus('error', 'Host load failed');
                setLog(err.message);
                renderHosts();
            } finally {
                setControlsBusy(false);
            }
        }

        function renderHosts() {
            if (!els.hosts) return;
            if (!state.hosts.length) {
                els.hosts.innerHTML = '<option value="">No saved hosts</option>';
                els.hosts.disabled = true;
                if (els.empty) {
                    els.empty.style.display = 'flex';
                    els.empty.querySelector('span').textContent = 'No saved hosts are available. Save a server record in Entrance first.';
                }
                return;
            }
            els.hosts.disabled = false;
            els.hosts.innerHTML = state.hosts.map((host, index) => {
                const label = `${host.user || '?'}@${host.host || '?'}:${host.port || 22}`;
                return `<option value="${index}">${escapeHtml(label)}</option>`;
            }).join('');
            if (els.empty) {
                els.empty.style.display = state.connected ? 'none' : 'flex';
                els.empty.querySelector('span').textContent = 'Select a saved host to start sampling CPU, memory, disk, and network activity.';
            }
        }

        function connectSelectedHost() {
            const index = parseInt(els.hosts?.value || '', 10);
            const host = state.hosts[index];
            if (!host) {
                setStatus('error', 'No host selected');
                setLog('Select a saved host before connecting.');
                return;
            }

            let authPayload;
            try {
                authPayload = getHostCredentialPayload(host);
            } catch (err) {
                setStatus('error', 'Credential needed');
                setLog(err.message);
                return;
            }

            cleanupConnection();
            resetSamples();
            state.selectedHost = host;
            setStatus('idle', 'Connecting');
            setLog(`Connecting to ${host.user}@${host.host}:${host.port || 22}...`);
            setControlsBusy(true);

            const ws = new WebSocket(buildWsUrl('/ssh'));
            state.ws = ws;
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: 'connect',
                    host: host.host,
                    port: Number(host.port || 22),
                    username: host.user,
                    ...authPayload
                }));
            };
            ws.onmessage = event => handleWsMessage(event);
            ws.onerror = () => {
                setStatus('error', 'WebSocket error');
                setLog('WebSocket connection failed.');
                setControlsBusy(false);
            };
            ws.onclose = () => {
                const wasConnected = state.connected;
                cleanupConnection();
                setControlsBusy(false);
                setConnectButton(false);
                if (wasConnected) {
                    setStatus('idle', 'Disconnected');
                    setLog('SSH connection closed.');
                }
            };
        }

        function handleWsMessage(event) {
            let message = null;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }

            if (message.type === 'connected') {
                state.connected = true;
                setControlsBusy(false);
                setConnectButton(true);
                setStatus('connected', 'Connected');
                if (els.empty) els.empty.style.display = 'none';
                setLog(`Connected. Sampling every ${formatInterval(state.intervalMs)}.`);
                startSampling();
                return;
            }

            if (message.type === 'data') {
                collectShellOutput(String(message.data || ''));
                return;
            }

            if (message.type === 'error') {
                setStatus('error', 'SSH error');
                setLog(message.message || 'SSH command failed.');
                return;
            }

            if (message.type === 'disconnected') {
                disconnect();
            }
        }

        function startSampling() {
            stopSampling();
            sendSampleCommand();
            state.timer = window.setInterval(sendSampleCommand, state.intervalMs);
        }

        function stopSampling() {
            if (state.timer) {
                window.clearInterval(state.timer);
                state.timer = null;
            }
        }

        function sendSampleCommand() {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.inFlight) return;
            const command = buildSampleCommand();
            state.inFlight = true;
            state.ws.send(JSON.stringify({ type: 'data', data: `${command}\n` }));
            if (state.inFlightTimer) window.clearTimeout(state.inFlightTimer);
            state.inFlightTimer = window.setTimeout(() => {
                state.inFlight = false;
                setLog('Sample timed out; waiting for the next interval.');
            }, Math.max(2500, state.intervalMs * 2));
        }

        function buildSampleCommand() {
            const begin = `${SAMPLE_PREFIX}_BEGIN`;
            const end = `${SAMPLE_PREFIX}_END`;
            return [
                `printf '${begin}\\n'`,
                `awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; printf "CPU|%s|%s\\n", total, idle}' /proc/stat`,
                `awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2} END{printf "MEM|%s|%s\\n", t, a}' /proc/meminfo`,
                `df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); printf "DISK|%s|%s|%s|%s\\n",$3,$2,$5,$6}'`,
                `awk -F'[: ]+' 'BEGIN{rx=0;tx=0} $2!="lo" && $2!="" {rx+=$3; tx+=$11} END{printf "NET|%s|%s\\n", rx, tx}' /proc/net/dev`,
                `printf '${end}\\n'`
            ].join('; ');
        }

        function collectShellOutput(chunk) {
            state.buffer += chunk.replace(/\r/g, '');
            const begin = `${SAMPLE_PREFIX}_BEGIN`;
            const end = `${SAMPLE_PREFIX}_END`;
            let beginIndex = state.buffer.indexOf(begin);
            let endIndex = state.buffer.indexOf(end, beginIndex + begin.length);
            while (beginIndex >= 0 && endIndex >= 0) {
                const segment = state.buffer.slice(beginIndex + begin.length, endIndex);
                state.buffer = state.buffer.slice(endIndex + end.length);
                parseSample(segment);
                beginIndex = state.buffer.indexOf(begin);
                endIndex = state.buffer.indexOf(end, beginIndex + begin.length);
            }
            if (state.buffer.length > 20000) {
                state.buffer = state.buffer.slice(-8000);
            }
        }

        function parseSample(segment) {
            state.inFlight = false;
            if (state.inFlightTimer) {
                window.clearTimeout(state.inFlightTimer);
                state.inFlightTimer = null;
            }

            const sample = {};
            segment.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.includes('|')) return;
                const parts = trimmed.split('|');
                sample[parts[0]] = parts.slice(1);
            });

            const now = Date.now();
            updateCpu(sample.CPU);
            updateMemory(sample.MEM);
            updateDisk(sample.DISK);
            updateNetwork(sample.NET, now);
            renderMetrics();
            setLog(`Last sample ${new Date(now).toLocaleTimeString()} from ${state.selectedHost?.host || 'remote host'}.`);
        }

        function updateCpu(parts) {
            if (!parts || parts.length < 2) return;
            const total = Number(parts[0]);
            const idle = Number(parts[1]);
            if (!Number.isFinite(total) || !Number.isFinite(idle)) return;
            if (state.lastCpu) {
                const totalDelta = total - state.lastCpu.total;
                const idleDelta = idle - state.lastCpu.idle;
                const usage = totalDelta > 0 ? clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100) : 0;
                state.latest.cpu = { percent: usage };
            }
            state.lastCpu = { total, idle };
        }

        function updateMemory(parts) {
            if (!parts || parts.length < 2) return;
            const totalKb = Number(parts[0]);
            const availableKb = Number(parts[1]);
            if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return;
            const usedKb = Math.max(0, totalKb - availableKb);
            state.latest.mem = {
                percent: clamp((usedKb / totalKb) * 100, 0, 100),
                usedBytes: usedKb * 1024,
                totalBytes: totalKb * 1024
            };
        }

        function updateDisk(parts) {
            if (!parts || parts.length < 4) return;
            const usedKb = Number(parts[0]);
            const totalKb = Number(parts[1]);
            const percent = Number(parts[2]);
            state.latest.disk = {
                percent: Number.isFinite(percent) ? clamp(percent, 0, 100) : 0,
                usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : 0,
                totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : 0,
                mount: parts[3] || '/'
            };
        }

        function updateNetwork(parts, now) {
            if (!parts || parts.length < 2) return;
            const rx = Number(parts[0]);
            const tx = Number(parts[1]);
            if (!Number.isFinite(rx) || !Number.isFinite(tx)) return;
            if (state.lastNet) {
                const seconds = Math.max(0.001, (now - state.lastNet.time) / 1000);
                const rxRate = Math.max(0, (rx - state.lastNet.rx) / seconds);
                const txRate = Math.max(0, (tx - state.lastNet.tx) / seconds);
                const totalRate = rxRate + txRate;
                state.networkScale = Math.max(state.networkScale * 0.92, totalRate * 1.25, 1024 * 1024);
                state.latest.net = {
                    percent: clamp((totalRate / state.networkScale) * 100, 0, 100),
                    rxRate,
                    txRate,
                    totalRate
                };
            }
            state.lastNet = { rx, tx, time: now };
        }

        function renderMetrics() {
            const cpu = state.latest.cpu;
            updateRing(CPU_CARD, cpu ? cpu.percent : 0, cpu ? `${cpu.percent.toFixed(0)}%` : '--', 'usage');
            setDetail(CPU_CARD, cpu ? `${cpu.percent.toFixed(1)}% active across all cores` : 'Collecting baseline sample');

            const mem = state.latest.mem;
            updateRing(MEM_CARD, mem ? mem.percent : 0, mem ? `${mem.percent.toFixed(0)}%` : '--', 'used');
            setDetail(MEM_CARD, mem ? `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}` : 'Waiting for memory counters');

            const disk = state.latest.disk;
            updateRing(DISK_CARD, disk ? disk.percent : 0, disk ? `${disk.percent.toFixed(0)}%` : '--', disk ? disk.mount : 'root');
            setDetail(DISK_CARD, disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} on ${disk.mount}` : 'Waiting for root filesystem usage');

            const net = state.latest.net;
            updateRing(NET_CARD, net ? net.percent : 0, net ? formatRateShort(net.totalRate) : '--', 'RX + TX');
            setDetail(NET_CARD, net ? `RX ${formatRate(net.rxRate)} · TX ${formatRate(net.txRate)}` : 'Collecting network baseline sample');
        }

        function buildRings() {
            Object.keys(els.rings).forEach(key => {
                if (!els.rings[key]) return;
                els.rings[key].innerHTML = ringHtml('--', 0, key === NET_CARD ? 'B/s' : '%');
            });
        }

        function ringHtml(text, percent, unit) {
            const radius = 50;
            const circumference = 2 * Math.PI * radius;
            const offset = circumference * (1 - clamp(percent, 0, 100) / 100);
            return `
                <svg viewBox="0 0 120 120" aria-hidden="true">
                    <circle class="etop-track" cx="60" cy="60" r="${radius}"></circle>
                    <circle class="etop-progress" cx="60" cy="60" r="${radius}" style="stroke-dasharray:${circumference.toFixed(2)};stroke-dashoffset:${offset.toFixed(2)}"></circle>
                </svg>
                <div class="etop-ring-center">
                    <div class="etop-value">${escapeHtml(text)}</div>
                    <div class="etop-unit">${escapeHtml(unit)}</div>
                </div>
            `;
        }

        function updateRing(key, percent, text, unit) {
            if (!els.rings[key]) return;
            els.rings[key].innerHTML = ringHtml(text, percent, unit);
        }

        function setDetail(key, text) {
            if (els.details[key]) els.details[key].textContent = text;
        }

        function resetSamples() {
            state.buffer = '';
            state.inFlight = false;
            state.lastCpu = null;
            state.lastNet = null;
            state.networkScale = 1024 * 1024;
            state.latest = { cpu: null, mem: null, disk: null, net: null };
            renderMetrics();
        }

        function disconnect() {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'disconnect' }));
            }
            cleanupConnection();
            setControlsBusy(false);
            setConnectButton(false);
            setStatus('idle', 'Disconnected');
            setLog('Disconnected.');
            if (els.empty) els.empty.style.display = state.hosts.length ? 'flex' : 'none';
        }

        function cleanupConnection() {
            stopSampling();
            if (state.inFlightTimer) {
                window.clearTimeout(state.inFlightTimer);
                state.inFlightTimer = null;
            }
            state.inFlight = false;
            state.connected = false;
            if (state.ws) {
                const ws = state.ws;
                state.ws = null;
                ws.onopen = null;
                ws.onmessage = null;
                ws.onerror = null;
                ws.onclose = null;
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            }
        }

        function cleanup() {
            disconnect();
            window.removeEventListener('beforeunload', cleanup);
        }

        function setStatus(stateName, text) {
            if (!els.status) return;
            els.status.dataset.state = stateName;
            const icon = stateName === 'connected' ? 'fa-circle-check' : stateName === 'error' ? 'fa-triangle-exclamation' : 'fa-circle';
            els.status.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(text)}</span>`;
        }

        function setLog(text) {
            if (els.log) els.log.textContent = text;
        }

        function setControlsBusy(busy) {
            if (els.refresh) els.refresh.disabled = busy;
            if (els.hosts) els.hosts.disabled = busy || !state.hosts.length || state.connected;
            if (els.interval) els.interval.disabled = busy;
            if (els.connect) els.connect.disabled = busy || (!state.connected && !state.hosts.length);
        }

        function setConnectButton(connected) {
            if (!els.connect) return;
            els.connect.classList.toggle('primary', !connected);
            els.connect.innerHTML = connected
                ? '<i class="fas fa-xmark"></i><span>Disconnect</span>'
                : '<i class="fas fa-plug"></i><span>Connect</span>';
            if (els.hosts) els.hosts.disabled = connected || !state.hosts.length;
        }

        function buildWsUrl(path) {
            const url = new URL(path, context.apiBase || window.location.origin);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            if (context.token) {
                url.searchParams.set('token', context.token);
            }
            return url.toString();
        }

        function getHostCredentialPayload(host) {
            const privateKey = String(host.privateKey || '').replace(/\r\n/g, '\n').trim();
            const password = host.pass || host.password || '';
            const passphrase = host.passphrase || '';
            const authType = normalizeAuthType(host.authType, privateKey);

            if (authType === AUTH_TYPE_KEY) {
                if (!privateKey) {
                    throw new Error('This host has no saved private key. Edit the host record in Entrance first.');
                }
                return passphrase
                    ? { authType: AUTH_TYPE_KEY, privateKey, passphrase }
                    : { authType: AUTH_TYPE_KEY, privateKey };
            }

            if (!password) {
                throw new Error('This host has no saved password. Edit the host record in Entrance first.');
            }
            return { authType: AUTH_TYPE_PASSWORD, password };
        }
    }

    function normalizeAuthType(authType, privateKey) {
        const lowered = String(authType || '').trim().toLowerCase();
        if (lowered === AUTH_TYPE_KEY || lowered === 'privatekey' || lowered === 'private_key') return AUTH_TYPE_KEY;
        if (lowered === AUTH_TYPE_PASSWORD || lowered === 'pass') return AUTH_TYPE_PASSWORD;
        return privateKey ? AUTH_TYPE_KEY : AUTH_TYPE_PASSWORD;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, Number(value) || 0));
    }

    function formatInterval(ms) {
        return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        let size = value;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }
        return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
    }

    function formatRate(bytesPerSecond) {
        return `${formatBytes(bytesPerSecond)}/s`;
    }

    function formatRateShort(bytesPerSecond) {
        const value = Number(bytesPerSecond) || 0;
        if (value < 1024) return `${value.toFixed(0)}`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)}K`;
        if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}M`;
        return `${(value / 1024 / 1024 / 1024).toFixed(1)}G`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
