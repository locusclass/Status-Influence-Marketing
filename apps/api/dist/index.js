import 'dotenv/config';
import { buildServer } from './server.js';
import { config, getStartupConfigIssues, isFatalStartupIssue } from './config.js';
const startupIssues = getStartupConfigIssues();
if (startupIssues.length > 0) {
    const fatalIssues = startupIssues.filter((issue) => isFatalStartupIssue(issue));
    console.error('STARTUP CONFIG CHECK');
    for (const issue of startupIssues) {
        console.error(`- ${issue}`);
    }
    if (fatalIssues.length > 0) {
        process.exit(1);
    }
}
const app = buildServer();
const port = Number(process.env.PORT) || config.port || 3000;
app.listen({ port, host: '0.0.0.0' })
    .then(() => {
    app.log.info(`API listening on ${port}`);
})
    .catch((err) => {
    app.log.error(err);
    process.exit(1);
});
