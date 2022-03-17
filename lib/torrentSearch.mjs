import TorrentSearchApi from 'torrent-search-api';
import { MOVIE_STATUS, SHOW_STATUS, showEpIt } from './utilities.mjs';

const movieProviderTiers = [
    ['1337x', 'RarbG',],
    ['Yts'],
    ['KickassTorrents'],
    ['ThePirateBay', 'Torrentz2'],
];
const showProviderTiers = [
    ['1337x', 'RarbG',],
    ['Yts'],
    ['KickassTorrents'],
    ['ThePirateBay', 'Torrentz2'],
];
const movieTerms = [
    '1080p webrip',
    '1080p brrip',
    'webrip',
    'brrip',
    'HD',
    '',
];
const showTerms = [
    '1080p webrip',
    '1080p brrip',
    'webrip',
    'brrip',
    'HD',
    '',
];
async function findMovieTorrent(movie) {
    const query = `${movie.title} ${movie.release_date.substring(0, 4)}`;
    let res = undefined;
    try {
        for (const tier of movieProviderTiers) {
            tier.forEach(provider => TorrentSearchApi.enableProvider(provider));
            for (const term of movieTerms) {
                res = (await TorrentSearchApi.search(`${query} ${term}`, 'Movies', 1))[0];
                res = res?.seeds > process.env.MIN_SEEDS ? res : undefined;
                if (res) break;
            }
            TorrentSearchApi.disableAllProviders();
            if (res) break;
        }
        if (res) res = { ...res, magnet: await TorrentSearchApi.getMagnet(res) }
    } catch (error) {
        console.log('find movie torrent error:');
        console.log(error);
    }

    return res;
}
async function findEpisodeTorrent(show, sep) {
    const query = `${show.name} ${sep}`;
    let res = undefined;
    try {
        for (const tier of showProviderTiers) {
            tier.forEach(provider => TorrentSearchApi.enableProvider(provider));
            for (const term of showTerms) {
                res = (await TorrentSearchApi.search(`${query} ${term}`, 'TV', 1))[0];
                res = (res?.seeds > process.env.MIN_SEEDS) ? res : undefined;
                if (res) break;
            }
            TorrentSearchApi.disableAllProviders();
            if (res) break;
        }
        if (res) res = { ...res, magnet: await TorrentSearchApi.getMagnet(res) }
    } catch (error) {
        console.log('find episode torrent');
        console.log(error);
    }
    return res;
}
async function appendMovieTorrent(movie) {
    try {
        const torrent = await findMovieTorrent(movie);
        if (!torrent) return movie;
        console.log(torrent);
        return { ...movie, torrent, status: MOVIE_STATUS.QUEUE }
    } catch (error) {
        console.log('append movie torrent error:');
        console.log(error);
    }
    return movie;
}
async function appendShowTorrent(show) {
    try {
        let changed = false;
    for (const sep of showEpIt(show)) {
        if (show[sep]) continue;
        const torrent = await findEpisodeTorrent(show, sep);
        if (torrent) {
            console.log(torrent);
            changed = true;
            show[sep] = torrent;
        }
    }
    if (!changed) return show;
    return { ...show, status: SHOW_STATUS.DOWNLOADING }
    } catch (error) {
        console.log('append show torrent error:');
        console.log(error);
    }
    return show;
}

const torrentSearch = {
    appendMovieTorrent: appendMovieTorrent,
    appendShowTorrent: appendShowTorrent,
}
export {
    torrentSearch,
}
