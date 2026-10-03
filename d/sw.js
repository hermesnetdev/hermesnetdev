self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

let nextReqId = 1;

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/--enidor-stream--/')) {
        const path = decodeURIComponent(url.pathname.split('/--enidor-stream--/')[1]);
        
        event.respondWith(new Promise((resolve, reject) => {
            const reqId = nextReqId++;
            
            self.clients.matchAll({ type: 'window' }).then(clients => {
                if (clients.length === 0) return reject(new Error('no client found to serve stream'));
                
                let client = clients.find(c => c.id === event.clientId) || clients[0];
                
                const channel = new MessageChannel();
                
                channel.port1.onmessage = (msg) => {
                    if (msg.data.type === 'ENIDOR_STREAM_RESPONSE') {
                        resolve(new Response(msg.data.stream, {
                            status: msg.data.status,
                            statusText: msg.data.statusText,
                            headers: msg.data.headers
                        }));
                    } else if (msg.data.type === 'ENIDOR_STREAM_ERROR') {
                        reject(new Error(msg.data.error));
                    }
                };
                
                client.postMessage({
                    type: 'ENIDOR_STREAM_REQUEST',
                    reqId,
                    path,
                    range: event.request.headers.get('Range')
                }, [channel.port2]);
            }).catch(reject);
        }));
    }
});
