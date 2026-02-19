import { buildServer } from './server.js';
import { config } from './config.js';

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
