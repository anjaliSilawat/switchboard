import { useEffect, useRef, useState } from 'react';

export interface Frame {
  seq?: number;
  type: string;
  contact?: string;
  after?: number;
}

// Opens the WebSocket for one workspace and calls onFrame for every update.
// If the connection drops, it reconnects with ?after=<last seq we saw>,
// so the server re-sends everything we missed.
export function useLiveUpdates(workspace: string, onFrame: (frame: Frame) => void) {
  const [online, setOnline] = useState(false);

  // keep the latest callback without reconnecting every render
  const callback = useRef(onFrame);
  callback.current = onFrame;

  useEffect(() => {
    let lastSeq: number | undefined;
    let socket: WebSocket | undefined;
    let stopped = false;
    let retryDelay = 500;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      let url = `${protocol}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}`;
      if (lastSeq !== undefined) url += `&after=${lastSeq}`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        setOnline(true);
        retryDelay = 500;
      };

      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data) as Frame;
        if (frame.type === 'hello') {
          // first connection: start from where the server is now
          if (lastSeq === undefined) lastSeq = frame.after;
          return;
        }
        if (typeof frame.seq === 'number') {
          if (lastSeq !== undefined && frame.seq <= lastSeq) return; // already seen
          lastSeq = frame.seq;
        }
        callback.current(frame);
      };

      socket.onclose = () => {
        setOnline(false);
        if (stopped) return;
        retryDelay = Math.min(retryDelay * 2, 8000); // wait longer each time, max 8 s
        setTimeout(connect, retryDelay);
      };
    }

    connect();
    return () => {
      stopped = true;
      socket?.close();
    };
  }, [workspace]);

  return online;
}
