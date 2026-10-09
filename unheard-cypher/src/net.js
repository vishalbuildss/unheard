import { io } from 'socket.io-client';

// Socket plus a clock that follows the server, so every screen shows the same countdown.
export function createNet() {
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
  const samples = [];
  let offset = 0;
  return {
    socket,
    sync(serverTime) {
      samples.push(serverTime - Date.now());
      if (samples.length > 8) samples.shift();
      offset = Math.max(...samples); // the sample with the least network delay is the truest
    },
    serverNow: () => Date.now() + offset,
    emit: (event, data) => new Promise(resolve => {
      socket.timeout(5000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: 'The server did not answer. Try again.' } : res));
    })
  };
}
