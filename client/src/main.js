import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Movies from './views/Movies.vue';
import Shows from './views/Shows.vue';
import Settings from './views/Settings.vue';
import Activity from './views/Activity.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/',         redirect: '/movies' },
    { path: '/movies',   component: Movies },
    { path: '/shows',    component: Shows },
    { path: '/settings', component: Settings },
    { path: '/activity', component: Activity },
  ],
});

createApp(App).use(router).mount('#app');
