const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const nunjucks = require('nunjucks');

// Load configuration
const configPath = path.join(__dirname, 'config.yml');
let config;

try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    config = yaml.load(fileContents);
} catch (error) {
    console.error('❌ Error reading config.yml:', error.message);
    console.log('\nCreate a config.yml file with this structure:');
    console.log('source: http://ip:port\napiKey: your_api_key_here\npollInterval: 30\nport: 3000\nhost: http://localhost:3000');
    process.exit(1);
}

// Store monitors data
let monitorsData = [];
let lastUpdate = null;
let lastError = null;

// Create Express app
const app = express();

// Configure Nunjucks
nunjucks.configure('views', {
    autoescape: true,
    express: app
});

// Serve static files from public directory
app.use(express.static('public'));

// Homepage - List all monitors
app.get('/', (req, res) => {
    // Prepare data for template
    const viewData = {
        source: config.source,
        lastUpdate: lastUpdate ? lastUpdate.toLocaleString() : 'Never',
        pollInterval: config.pollInterval,
        totalMonitors: monitorsData.length,
        lastError: lastError,
        noMonitors: monitorsData.length === 0,
        monitors: monitorsData.map((monitor, index) => {
            const statusClass = monitor.status === 'UP' ? 'up' : 'down';
            const slug = encodeURIComponent(monitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
            const baseUrl = config.host || `http://localhost:${config.port}`;
            const fullUrl = `${baseUrl}/monitor/${slug}`;

            return {
                index: index,
                name: monitor.name,
                status: monitor.status,
                statusClass: statusClass,
                url: monitor.url,
                type: monitor.type,
                responseTime: monitor.responseTime,
                certDaysRemaining: monitor.certDaysRemaining,
                fullUrl: fullUrl
            };
        })
    };

    res.render('index.html', viewData);
});

// Individual monitor endpoint
app.get('/monitor/:slug', (req, res) => {
    const slug = req.params.slug;

    // Find monitor by slug
    const monitor = monitorsData.find(m => {
        const monitorSlug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return monitorSlug === slug;
    });

    if (!monitor) {
        return res.status(404).send('ko');
    }

    if (monitor.status === 'UP') {
        res.status(200).send('ok');
    } else {
        res.status(503).send('ko');
    }
});

// Fetch monitors from remote Uptime Kuma
async function fetchMonitors() {
    try {
        const response = await axios.get(`${config.source}/metrics`, {
            auth: {
                username: '',
                password: config.apiKey
            }
        });

        const metrics = parsePrometheusMetrics(response.data);
        const monitors = getMonitorsFromMetrics(metrics);

        monitorsData = monitors;
        lastUpdate = new Date();
        lastError = null;

        console.log(`✓ Updated ${monitors.length} monitors at ${lastUpdate.toLocaleString()}`);

    } catch (error) {
        const errorMsg = error.response
            ? `HTTP ${error.response.status}: ${error.response.statusText}`
            : error.message;

        lastError = errorMsg;
        console.error('❌ Error fetching monitors:', errorMsg);
    }
}

function parsePrometheusMetrics(data) {
    const lines = data.split('\n');
    const metrics = {};

    lines.forEach(line => {
        if (line.startsWith('#') || line.trim() === '') return;

        const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\{([^}]+)\}\s+(.+)$/);
        if (match) {
            const metricName = match[1];
            const labels = {};
            const labelPairs = match[2].match(/(\w+)="([^"]*)"/g);

            if (labelPairs) {
                labelPairs.forEach(pair => {
                    const [key, value] = pair.split('=');
                    labels[key] = value.replace(/"/g, '');
                });
            }

            const value = parseFloat(match[3]);

            if (!metrics[metricName]) {
                metrics[metricName] = [];
            }

            metrics[metricName].push({ labels, value });
        }
    });

    return metrics;
}

function getMonitorsFromMetrics(metrics) {
    const monitorsMap = new Map();

    ['monitor_status', 'monitor_response_time', 'monitor_cert_days_remaining'].forEach(metricName => {
        if (metrics[metricName]) {
            metrics[metricName].forEach(metric => {
                const name = metric.labels.monitor_name;

                if (!name) return;

                if (!monitorsMap.has(name)) {
                    monitorsMap.set(name, {
                        name: name,
                        type: metric.labels.monitor_type || 'N/A',
                        url: metric.labels.monitor_url || null,
                        hostname: metric.labels.monitor_hostname !== 'null' ? metric.labels.monitor_hostname : null,
                        port: metric.labels.monitor_port !== 'null' ? metric.labels.monitor_port : null
                    });
                }

                const monitor = monitorsMap.get(name);

                if (metricName === 'monitor_status') {
                    const status = metric.value === 1 ? 'UP' : 'DOWN';
                    monitor.status = status;
                    monitor.emoji = metric.value === 1 ? '🟢' : '🔴';
                } else if (metricName === 'monitor_response_time') {
                    monitor.responseTime = metric.value;
                } else if (metricName === 'monitor_cert_days_remaining') {
                    monitor.certDaysRemaining = metric.value;
                }
            });
        }
    });

    return Array.from(monitorsMap.values());
}

async function start() {
    console.log('🚀 Starting Subtime Kuma...\n');

    // Validate configuration
    if (!config.pollInterval || config.pollInterval < 1) {
        console.error('❌ Invalid pollInterval in config.yml (must be >= 1)');
        process.exit(1);
    }

    if (!config.port || config.port < 1 || config.port > 65535) {
        console.error('❌ Invalid port in config.yml (must be between 1 and 65535)');
        process.exit(1);
    }

    // Initial fetch
    await fetchMonitors();

    // Set up recurring poll
    setInterval(fetchMonitors, config.pollInterval * 1000);

    // Start web server
    app.listen(config.port, () => {
        console.log(`\n🌐 Web server running on http://localhost:${config.port}`);
        console.log(`📊 View monitors: http://localhost:${config.port}/`);
        console.log(`\n✓ Polling every ${config.pollInterval}s from ${config.source}\n`);
    });
}

start();
