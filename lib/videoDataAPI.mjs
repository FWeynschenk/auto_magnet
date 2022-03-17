import TMDB from 'got-tmdb';
const tmdbOptions = {
    apiKey: process.env.TMDB_API_KEY,
}
const mdb = new TMDB(tmdbOptions);

// api docs https://developers.themoviedb.org/3/search/

// options
//      all strings or it won't work
//      year: number
//      primary_release_year: number
//      include_adult: boolean
async function findMovies(query, options = {}) {
    try {
        const res = await mdb.Search.searchMovies({ query: query, ...options });
        return res;
    } catch (error) {
        console.error(error);
        return error;
    }
}

async function findShows(query, options = {}) {
    try {
        const res = await mdb.Search.searchTVShows({ query: query, ...options });
        return res;

    } catch (error) {
        console.log('find shows error:')
        console.error(error);
    }
    throw 'find shows error';
}

async function showDetails(show) {
    try {
        const details = await mdb.TV.getDetails(show.id, {});
        return details;
    } catch (error) {
        console.log(error);
    }
    throw 'show details error'
}
async function movieDetails(movie) {
    try {
        const details = await mdb.Movies.getDetails(movie.id, {});
        return details;
    } catch (error) {
        console.log('movie details error');
        console.log(error);
    }
    throw 'movie details error';
}

const actions = {
    findMovies: findMovies,
    findShows: findShows,
    showDetails: showDetails,
    movieDetails: movieDetails,
}

export {
    actions,
}