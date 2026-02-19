import { buildServer } from './server.js';
import { config } from './config.js';
const app = buildServer();
app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
    app.log.info(`API listening on ${config.port}`);
}).catch((err) => {
    app.log.error(err);
    process.exit(1);
});
