import { LocalStorage } from 'node-localstorage';
const settingStore = new LocalStorage('./scratch/settings');
const movieStore = new LocalStorage('./scratch/movies');
const showStore = new LocalStorage('./scratch/shows');
fillDefaults();

function saveMovie(movie) {
    const id = movie.id ? movie.id : Math.random();
    movieStore.setItem(id, JSON.stringify(movie));
    return { ...movie, id: id }
}
function saveShow(show) {
    const id = show.id ? show.id : Math.random();
    showStore.setItem(id, JSON.stringify(show));
    return { ...show, id: id }
}
function getMovies() {
    const movies = [];
    for (const key of movieStore._keys) {
        movies.push({ ...JSON.parse(movieStore.getItem(key)), id: key });
    }
    return movies;
}
function getShows() {
    const shows = [];
    for (const key of showStore._keys) {
        shows.push({ ...JSON.parse(showStore.getItem(key)), id: key });
    }
    return shows;
}
function deleteMovie(movie) {
    movieStore.removeItem(movie.id);
}
function deleteShow(show) {
    showStore.removeItem(show.id)
}

const scratchStore = {
    saveMovie,
    saveShow,
    getMovies,
    getShows,
    deleteMovie,
    deleteShow,
}
export {
    scratchStore,
}

function fillDefaults() {
    const defaults = {
        language: 'english',
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (!settingStore.getItem(key)) {
            settingStore.setItem(key, value);
        }
    }
}