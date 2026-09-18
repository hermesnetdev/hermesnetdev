// Entry point for assets/vendor/libp2p.js — the only libp2p surface the receive page uses.
// Rebuild with `npm ci && npm run build` from this directory.
export { createLibp2p } from 'libp2p'
export { webSockets } from '@libp2p/websockets'
export { webTransport } from '@libp2p/webtransport'
export { webRTC } from '@libp2p/webrtc'
export { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
export { identify } from '@libp2p/identify'
export { noise } from '@chainsafe/libp2p-noise'
export { yamux } from '@chainsafe/libp2p-yamux'
export { multiaddr } from '@multiformats/multiaddr'
