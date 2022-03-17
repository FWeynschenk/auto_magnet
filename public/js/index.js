import { createApp, reactive } from "/js/petite-vue.es.js";
import { MOVIE_STATUS, sleep, SHOW_STATUS } from "/js/utilities.mjs";
// TODO video.js


const v = reactive({
    // "consts"
    movieStatusDict: {
        [MOVIE_STATUS.DOWNLOADING]: { class: 'spinner-border spinner-border-sm text-success', msg: 'Downloading...' },
        [MOVIE_STATUS.DOWNLOADED]: { class: 'bi bi-circle-fill text-success', msg: 'Downloaded!' },
        [MOVIE_STATUS.SEARCHING]: { class: 'spinner-border spinner-border-sm text-info', msg: 'Searching...' },
        [MOVIE_STATUS.QUEUE]: { class: 'spinner-border spinner-border-sm text-warning', msg: 'Queued for download...' },
        [MOVIE_STATUS.UNKNOWN]: { class: 'bi bi-circle-fill text-danger', msg: 'Unknown!' },
    },
    showStatusDict: {
        [SHOW_STATUS.UNKNOWN]: { class: 'bi bi-circle-fill text-danger', msg: 'Unknown!' },
        [SHOW_STATUS.DOWNLOADING]: { class: 'spinner-border spinner-border-sm text-success', msg: 'Downloading...' },
        [SHOW_STATUS.DOWNLOADED]: { class: 'bi bi-circle-fill text-success', msg: 'Downloaded!' },
        [SHOW_STATUS.SEARCHING]: { class: 'spinner-border spinner-border-sm text-info', msg: 'Searching...' },
    },
    findStatusDict: {
        hidden: { class: 'invisible', msg: '' },
        waiting: { class: 'spinner-border spinner-border-sm', msg: 'Waiting for results...' },
        failed: { class: 'bi bi-circle-fill text-danger', msg: 'No results found...' },
    },
    posterPrefix: 'https://image.tmdb.org/t/p/w300',
    backdropPrefix: 'https://image.tmdb.org/t/p/original',

    bgURI: '',
    shows: [],
    movies: [],
    idSet: [],

    // scroll 
    topScr: "invisible",
    bottomScr: "",
    async updateScr() {
        await sleep(200);
        this.bottomScr = document.documentElement.scrollTopMax > document.documentElement.scrollTop ? "" : "invisible";
        this.topScr = document.documentElement.scrollTop > 0 ? "" : "invisible";
    },
    // search/filter
    find(search, id) {
        return new String(id).toLowerCase().includes(search.toLowerCase()) ?
            "" : "display: none;";
    },
    search: "",
    // websocket
    connection: undefined,
    async mounted() {
        this.connection = await new WebSocket(`ws://${location.host}/ws`);
        //this.connection.onopen = event => {};
        this.connection.onmessage = event => {
            const msg = JSON.parse(event.data);
            console.log(`cmd: ${msg.cmd}`);
            console.log(msg.data);
            switch (msg.cmd) {
                case 'foundMovies':
                    window.dispatchEvent(new CustomEvent('foundMovies', { detail: msg.data }));
                    break;
                case 'foundShows':
                    window.dispatchEvent(new CustomEvent('foundShows', { detail: msg.data }));
                    break;
                case 'data':
                    msg.data.movies.sort((b, a) => String(a.timeAdded).localeCompare(String(b.timeAdded)));
                    msg.data.shows.sort((b, a) => String(a.timeAdded).localeCompare(String(b.timeAdded)));
                    this.idSet = [...msg.data.movies, ...msg.data.shows].map(item => item.id);
                    this.movies = [];
                    this.shows = [];
                    setTimeout(() => { this.movies = msg.data.movies; this.shows = msg.data.shows }, 1);
                    // todo set background img
                    if (!this.bgURI) {
                        const bgs = [...msg.data.movies, ...msg.data.shows].flatMap(item => {
                            if (item.backdrop_path) return [item.backdrop_path];
                            return [];
                        });
                        if (bgs.length) {
                            this.bgURI = this.backdropPrefix + bgs[Math.floor(Math.random() * bgs.length)]
                        } else { this.bgURI = 'https://image.tmdb.org/t/p/original/9yKCJTOh9m3Lol2RY3kw99QPH6x.jpg'; }
                    }
                    break;
                case 'recent':
                    // todo highlight recent additions
                    break;
                default:
            }
        }
    },
    async wsSend(cmd, obj) {
        this.connection.send(JSON.stringify({ cmd, data: obj }));
    }
});

// elements
function Movie(movie, index) {
    return {
        $template: '#movie',
        index: index,
        title: movie.title,
        status: movie.status,
        poster: movie.poster_path,
        summary: movie.overview,
        releaseDate: movie.release_date,
        rating: movie.vote_average,
        id: movie.id,
        delMovie() {
            v.wsSend('delMovie', movie);
        },
        delMovieWithData() {
            v.wsSend('delMovieWithData', movie);
        },
    }
}
function Show(show, index) { // TODO
    console.log(show.status)
    return {
        $template: '#show',
        index: index,
        title: show.name,
        status: show.status,
        poster: show.poster_path,
        summary: show.overview,
        releaseDate: show.first_air_date,
        rating: show.vote_average,
        id: show.id,
        delMovie() {
            v.wsSend('delShow', show)
        }
    }
}
function Add() {
    const add = {
        query: "",
        year: undefined,
        foundMovies: [],
        foundShows: [],
        resStatus: "hidden",
        async findMovie() {
            if (!this.query) return;
            this.resStatus = "waiting";
            this.foundMovies = [];
            this.foundShows = [];
            const options = this.year ? { year: String(this.year) } : {};
            v.wsSend('findMovies', { query: this.query, options: options });
        },
        async findShow() {
            if (!this.query) return;
            this.resStatus = "waiting";
            this.foundMovies = [];
            this.foundShows = [];
            const options = this.year ? { primary_release_year: this.year } : {};
            v.wsSend('findShows', { query: this.query, options: options });
        },
        listMovieResults(e) {
            this.foundMovies = e.detail.results;
            if (e.detail.results?.length > 0) {
                this.resStatus = "hidden"
            } else {
                this.resStatus = "failed"
            }
        },
        listShowResults(e) {
            this.foundShows = e.detail.results;
            if (e.detail.results?.length > 0) {
                this.resStatus = "hidden"
            } else {
                this.resStatus = "failed"
            }
        },
        mounted() {
            window.addEventListener('foundMovies', this.listMovieResults);
            window.addEventListener('foundShows', this.listShowResults);
        }
    }
    return add;
}
function FoundMovie(movie) {
    return {
        $template: '#foundMovie',
        title: movie.title,
        poster: movie.poster_path,
        summary: movie.overview,
        releaseDate: movie.release_date,
        rating: movie.vote_average,
        btnEnabled: !v.idSet.includes(String(movie.id)),
        addMovie() {
            this.btnEnabled = false;
            v.wsSend('addMovie', movie);
        },
    }
}
function FoundShow(show) { // TODO
    return {
        $template: '#foundShow',
        id: show.id,
        title: show.name,
        poster: show.poster_path,
        summary: show.overview,
        releaseDate: show.first_air_date,
        rating: show.vote_average,
        btnEnabled: !v.idSet.includes(String(show.id)),
        addShow() {
            this.btnEnabled = false;
            v.wsSend('addShow', show);
            // specify seasons not to download and one field for future seasons
        },
    }
}

createApp({ Movie, Show, Add, FoundMovie, FoundShow, v, }).mount();

// modal input focus
document.getElementById('addModal').addEventListener('shown.bs.modal', function () {
    document.getElementById('addInput').focus();
});



