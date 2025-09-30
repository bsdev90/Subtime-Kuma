const axios = require('axios');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Load configuration
const configPath = path.join(__dirname, 'config.yml');
let config;

try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    config = yaml.load(fileContents);
} catch (error) {
    console.error('❌ Error reading config.yml:', error.message);
    console.log('\nCreate a config.yml file with this structure:');
    console.log('source: http://ip:port\napiKey: your_api_key_here');
    process.exit(1);
}

async function getMonitors() {
    try {
        console.log('🔗 Connecting to Uptime Kuma...\n');

        // Fetch metrics via /metrics endpoint with API key
        const response = await axios.get(`${config.source}/metrics`, {
            auth: {
                username: '',
                password: config.apiKey
            }
        });

        // Parse Prometheus metrics
        const metrics = parsePrometheusMetrics(response.data);

        console.log('✓ Data retrieved successfully\n');
        console.log('=== MONITORS AND THEIR STATUS ===\n');

        // Display monitors
        const monitors = getMonitorsFromMetrics(metrics);

        if (monitors.length > 0) {
            console.log(`Number of monitors: ${monitors.length}\n`);

            monitors.forEach(monitor => {
                console.log(`${monitor.emoji} [${monitor.status}] ${monitor.name}`);
                console.log(`   Type: ${monitor.type}`);
                console.log(`   URL: ${monitor.url || 'N/A'}`);
                if (monitor.hostname) {
                    console.log(`   Hostname: ${monitor.hostname}`);
                }
                if (monitor.port) {
                    console.log(`   Port: ${monitor.port}`);
                }
                if (monitor.responseTime) {
                    console.log(`   Response time: ${monitor.responseTime}ms`);
                }
                if (monitor.certDaysRemaining !== undefined) {
                    console.log(`   Certificate expires in: ${monitor.certDaysRemaining} days`);
                }
                console.log('');
            });
        } else {
            console.log('No monitors found.');
        }

    } catch (error) {
        if (error.response) {
            console.error('❌ HTTP Error:', error.response.status, error.response.statusText);
            if (error.response.status === 401) {
                console.error('   The API key is invalid or missing.');
            }
        } else {
            console.error('❌ Error:', error.message);
        }
        console.log('\nCheck that:');
        console.log('1. The URL in config.yml is correct');
        console.log('2. The API key in config.yml is valid');
        process.exit(1);
    }
}

function parsePrometheusMetrics(data) {
    const lines = data.split('\n');
    const metrics = {};

    lines.forEach(line => {
        // Ignore comments and empty lines
        if (line.startsWith('#') || line.trim() === '') return;

        // Parse metrics (format: metric_name{label="value"} value)
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

    // Extract information from different metrics
    ['monitor_status', 'monitor_response_time', 'monitor_cert_days_remaining'].forEach(metricName => {
        if (metrics[metricName]) {
            metrics[metricName].forEach(metric => {
                const name = metric.labels.monitor_name;

                // Use name as unique key
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

getMonitors();
