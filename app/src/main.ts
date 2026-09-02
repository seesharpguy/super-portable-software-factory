import { createApp } from 'vue'
import './fonts.css'
import App from './App.vue'
import './style.css'
import { registerWebMcpTools } from './lib/webmcp'

createApp(App).mount('#app')

// No-ops silently outside Chrome's WebMCP-enabled builds. .catch guards
// against any unexpected rejection surfacing as an unhandled promise error
// (per-tool failures are already caught inside registerWebMcpTools).
registerWebMcpTools().catch((err: unknown) => console.debug('[webmcp] registration failed', err))
