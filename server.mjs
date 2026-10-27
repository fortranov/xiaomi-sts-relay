import {createRelayServer} from './relay.mjs';

const port = Number(process.env.PORT || 3000);
const server = createRelayServer({clientKey: process.env.RELAY_CLIENT_KEY});
server.listen(port, '0.0.0.0', () => console.log(`Xiaomi STS relay listening on ${port}`));
