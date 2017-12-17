# Geckometrics
Expose Heroku metrics as a Geckoboard dashboard widget compatible API :chart_with_upwards_trend:

## How?
Deploy Geckometrics somewhere (for instance on an Heroku free hobby dyno), redirect the [log drain](https://devcenter.heroku.com/articles/log-drains) of the app you want to monitor to your geckometrics instance.

Set up some custom geckoboard widgets polling your geckometrics instance. You have your average response time, your request throughput and your dynos memory in realtime on your dashboard. Voila !

