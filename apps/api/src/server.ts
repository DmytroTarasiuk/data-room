import { createApp } from "./app.js";
import { env } from "./lib/env.js";

const app = createApp();

app.listen(env.API_PORT, () => {
  console.log(`Acme Data Room API listening on http://localhost:${env.API_PORT}`);
});
