import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Movies from './views/Movies.vue';
import Shows from './views/Shows.vue';
import Settings from './views/Settings.vue';
import Activity from './views/Activity.vue';
import Login from './views/Login.vue';
import { loadSession, user, isAdmin } from './session.js';
import { setUnauthorizedHandler } from './api.js';

// The player pulls in hls.js; load it only when someone actually watches.
const Watch     = () => import('./views/Watch.vue');
const ShowWatch = () => import('./views/ShowWatch.vue');
const Player    = () => import('./views/Player.vue');
const Account   = () => import('./views/Account.vue');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Where '/' goes depends on who is signed in, which is only known once the
    // guard has loaded the session — a redirect function would run before it.
    { path: '/',         component: Watch, meta: { home: true } },
    { path: '/login',    component: Login, meta: { public: true, bare: true } },
    { path: '/watch',    component: Watch },
    { path: '/watch/movies', component: Watch, props: { tab: 'movies' } },
    { path: '/watch/shows',  component: Watch, props: { tab: 'shows' } },
    { path: '/watch/show/:id', component: ShowWatch, props: true },
    { path: '/play/:kind/:id', component: Player, props: true, meta: { bare: true } },
    { path: '/movies',   component: Movies,   meta: { admin: true } },
    { path: '/shows',    component: Shows,    meta: { admin: true } },
    { path: '/settings', component: Settings, meta: { admin: true } },
    { path: '/account',  component: Account },
    { path: '/activity', component: Activity, meta: { admin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  await loadSession();
  if (to.meta.public) return true;
  if (!user.value) return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  if (to.meta.home) return isAdmin.value ? '/movies' : '/watch';
  if (to.meta.admin && !isAdmin.value) return '/watch';
  return true;
});

setUnauthorizedHandler(() => {
  user.value = null;
  const here = router.currentRoute.value;
  if (!here.meta.public) router.replace({ path: '/login', query: { next: here.fullPath } });
});

createApp(App).use(router).mount('#app');
