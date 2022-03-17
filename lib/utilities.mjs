const MOVIE_STATUS = {
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    SEARCHING: 'searching',
    QUEUE: 'queue',
    UNKNOWN: 'unknown'
}
const SHOW_STATUS = {
    UNKNOWN: 'unknown',
    DOWNLOADING: 'downloading',
    SEARCHING: 'searching',
    DOWNLOADED: 'downloaded',
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showEpIt(show) {
    const seps = [];
    for(const season of show.seasons) {
        if (season.season_number == 0) continue;
        const s = String(season.season_number).padStart(2, 0);
        for (let i = 1; i <= season.episode_count; i++) {
            const e = String(i).padStart(2, 0);
            const sep = `S${s}E${e}`;
            seps.push(sep);
        }
    }
    return seps;
}

export {
    SHOW_STATUS,
    MOVIE_STATUS,
    sleep,
    showEpIt,
}

