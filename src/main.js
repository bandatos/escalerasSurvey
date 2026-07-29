import './assets/main.css'

import App from './App.vue'
import { createApp } from 'vue'
import { pinia } from './stores'
import 'material-design-icons-iconfont/dist/material-design-icons.css'
import { aliases, md } from 'vuetify/iconsets/md'
import { registerPlugins } from '@/plugins'
import { useAuthStore } from '@/stores/authStore'
// Importar IndexedDB para inicializarlo
import './services/indexDB.js'


const app = createApp(App)
app.use(pinia)
registerPlugins(app)

// Cargar la sesión ANTES de montar, para que el token esté disponible
// sin depender del orden de montaje de los componentes (ej: recarga en /station/:id)
useAuthStore().loadSession()

app.mount('#app')
