'use strict';

const _ = require('lodash');
const express = require('express');
const moment = require('moment');
const pg = require('pg');

const datePattern = /(\d{4}-\d{2}-\d{2}T\d{2}[\d:.+]*) host/;
const token = process.env.TOKEN;

const app = express();
function bodyParser(req, res, next) {
    if (!req.is('application/logplex-1')) return next();

    req.logLine = '';
    req.setEncoding('utf8');
    req.on('data', function (chunk) {
        req.logLine += chunk;
    });
    req.on('end', next);
}
app.use(bodyParser);

app.post('/drain/' + token, function (req, res) {
    res.sendStatus(200);

    if (!req.logLine) return console.log('Error: No log line parsed.');

    const line = req.logLine;
    let metric = null;
    if (line.includes('heroku router') &&
        line.includes('service=') &&
        line.includes('status=')) {
        // 2016-06-09T07:32:15.360608+00:00 app[web.1]: 239 <158>1 2016-06-09T07:32:14.500838+00:00 host heroku router - at=info method=POST path="/login" host=app.dougs.fr request_id=7f4e29d2-e2f1-42d0-b47b-9150b2b1183a fwd="46.246.28.90" dyno=web.2 connect=1ms service=129ms status=200 bytes=5016
        metric = getMetricForRouter(line);
    } else if (line.includes('heroku web') &&
        line.includes('source=') &&
        line.includes('memory_total=')) {
        // 2016-06-09T07:32:16.527056+00:00 app[web.1]: 339 <45>1 2016-06-09T07:32:16.163266+00:00 host heroku web.2 - source=web.2 dyno=heroku.32934028.9646d93e-977a-421a-a5ef-02adc583e5b5 sample#memory_total=247.22MB sample#memory_rss=204.91MB sample#memory_cache=41.48MB sample#memory_swap=0.82MB sample#memory_pgpgin=2377742pages sample#memory_pgpgout=2339192pages sample#memory_quota=1024.00MB
        metric = getMetricForWeb(line);
    } else if (line.includes('heroku-postgres') &&
        line.includes('source=') &&
        line.includes('load-avg-15m=')) {
        // 2016-06-09T07:53:07.315320+00:00 app[web.1]: 531 <134>1 2016-06-09T07:52:53+00:00 host app heroku-postgres - source=DATABASE sample#current_transaction=48441 sample#db_size=247529644.0bytes sample#tables=28 sample#active-connections=3 sample#waiting-connections=0 sample#index-cache-hit-rate=0.99991 sample#table-cache-hit-rate=0.99994 sample#load-avg-1m=0.055 sample#load-avg-5m=0.035 sample#load-avg-15m=0.025 sample#read-iops=0 sample#write-iops=0.29701 sample#memory-total=3786332.0kB sample#memory-free=531500kB sample#memory-cached=2685020.0kB sample#memory-postgres=52128kB
        metric = getMetricForPostgres(line);
    }

    saveMetric(metric)
});

function getQueryForService(type, path) {
    const pathCondition = path ? ` AND metrics.path ='${path}'` : '';
    return `WITH intervals AS (
        SELECT
            date_trunc('second', now()) - (trunc(EXTRACT(seconds from now())) :: INTEGER % 10  || 'seconds') :: INTERVAL as start_time,
            now() as end_time
        UNION 
        SELECT
            (ref_time AT TIME ZONE 'utc') - ((i + 10) || ' seconds') :: INTERVAL start_time,
            (ref_time AT TIME ZONE 'utc') - (i || ' seconds') :: INTERVAL end_time
        FROM (
            SELECT
                date_trunc('second', now()) - (trunc(EXTRACT(seconds from now())) :: INTEGER % 10  || 'seconds') :: INTERVAL as ref_time,
                generate_series(0, 120, 10) AS i) t  
        )

        SELECT
            count(metrics.id),
                avg(metrics.service) AS average,
                intervals.start_time,
                intervals.end_time
            FROM intervals
            INNER JOIN metrics ON metrics.date >= intervals.start_time AND metrics.date < intervals.end_time
            WHERE
            metrics.type = '${type}' ${pathCondition}
            GROUP BY intervals.start_time, intervals.end_time
            ORDER BY intervals.start_time;`;
}

app.get('/service/search/' + token, serviceHandler('search'));
app.get('/service/home/' + token, serviceHandler('home'));
app.get('/service/property/' + token, serviceHandler('property'));

function serviceHandler(path) {
    return function (req, res) {
        const query = getQueryForService('router', path);
    
        pgQuery(query, (err, result) => {
            if (err) res.sendStatus(500);
    
            const items = result.rows.map(r => r.average);
            return res.json({
                item: [
                    {
                        value: items[items.length - 1]
                    },
                    items
                ]
            });
        });
    };
}

app.get('/throughput/' + token, function (req, res) {
    const query = getQueryForService('router');

    pgQuery(query, (err, result) => {
        if (err) res.sendStatus(500);

        const items = result.rows.map(r => r.count / 10);
        return res.json({
            item: [
                {
                    value: items[items.length - 1]
                },
                items
            ]
        });
    });
});

app.get('/memory/' + token, function (req, res) {
    const query = `
    WITH intervals AS (
        SELECT
          i AS                                                              id,
          (now() AT TIME ZONE 'utc') - ((i + 10) || ' minutes') :: INTERVAL start_time,
          (now() AT TIME ZONE 'utc') - ((i) || ' minutes') :: INTERVAL        end_time
        FROM generate_series(0, 120, 10) AS i
    )
    
    SELECT
      count(metrics.id),
      avg(metrics.memory) AS memory,
      intervals.start_time,
      intervals.end_time
    FROM intervals
      INNER JOIN metrics ON metrics.date >= intervals.start_time AND metrics.date < intervals.end_time
    WHERE
      metrics.type = 'web'
    GROUP BY intervals.id, intervals.start_time, intervals.end_time
    ORDER BY intervals.id DESC;`;

    pgQuery(query, (err, result) => {
        if (err) res.sendStatus(500);

        const items = result.rows.map(r => r.memory);
        return res.json({
            item: [
                {
                    value: items[items.length - 1]
                },
                items
            ]
        });
    });
});

const port = process.env.PORT || 3000;
app.listen(port, function () {
    console.log('listening on port ' + port);
});

function getMetricForRouter(line) {
    let date = new Date();
    let match = line.match(datePattern);
    if (match) date = new Date(match[1]);

    let service = 0;
    match = line.match(/service=(\d+)/);
    if (match) service = match[1];

    let status = 0;
    match = line.match(/status=(\d+)/);
    if (match) status = match[1];

    let path = null;
    path = getPathType(line);

    return { type: 'router', date, service, status, path}
}

function getMetricForWeb(line) {
    let date = new Date();
    let match = line.match(datePattern);
    if (match) date = new Date(match[1]);

    let source = '';
    match = line.match(/source=(\w+.\d+)/);
    if (match) source = match[1];

    let memory = 0;
    match = line.match(/memory_total=(\d+)/);
    if (match) memory = match[1];

    let memoryquota = 0;
    match = line.match(/memory_quota=(\d+)/);
    if (match) memoryquota = match[1];

    return { type: 'web', date, source, memory, memoryquota };
}

function getMetricForPostgres(line) {
    let date = new Date();
    let match = line.match(datePattern);
    if (match) date = new Date(match[1]);

    let source = '';
    match = line.match(/source=(\w+.\d+)/);
    if (match) source = match[1];

    let load = 0;
    match = line.match(/load-avg-15m=(\d+)/);
    if (match) load = match[1];


    return { type: 'postgres', date, source, load };
}

function saveMetric(metric) {
    if (metric) {
        _.defaults(metric, {
            type: null,
            path: null,
            date: new Date(),
            source: '',
            status: 0,
            service: 0,
            memory: 0,
            memoryquota: 0,
            load: 0
        });

        const query = `INSERT INTO metrics (type, date, source, status, service, memory, memoryquota, load, path) VALUES
            ('${metric.type}', '${moment(metric.date).format('YYYY-MM-DD HH:mm:ss')}', '${metric.source}', '${metric.status}',
            ${metric.service}, ${metric.memory}, ${metric.memoryquota}, ${metric.load}, '${metric.path}')`;
        pgQuery(query, () => true);
    }
}

function pgQuery(query, callback) {
    pg.connect(process.env.DATABASE_URL, function (err, client, done) {
        if (err) {
            console.error('error fetching client from pool', err);
            if (client) done(client);
            return callback(err);
        }

        client.query(query, function (err, result) {
            if (err) {
                console.error('error querying', query, err);
                if (client) done(client);
                return callback(err);
            }

            done();
            return callback(null, result);
        });
    });
};

function deleteOldMetrics() {
    pgQuery("DELETE FROM metrics WHERE metrics.date < (now() AT TIME ZONE 'utc') - INTERVAL '1 hours'", function (err, result) {
        if (err) return console.error('error', err);
        console.log(result.rowCount + ' old metrics deleted.');
    });
}

function getPathType(line) {
    const match = line.match(/path="(.+?)"/);
    if (!match && !match.length)
    return null;

    const path = match[1];
    if (path === "" || path === "/") {
        return "home";
    }

    if (path.startsWith("/property/")) {
        return "property";
    }

    if (path.startsWith("/to-rent/") || path.startsWith("/for-sale/")) {
        return "search";
    }

    return null;
}

setInterval(deleteOldMetrics, 20 * 60 * 1000);
console.log('Deleting old metrics.');
deleteOldMetrics();
