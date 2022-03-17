import Transmission from 'transmission';
import { MOVIE_STATUS, showEpIt } from './utilities.mjs';
const transStatusMap = {
    4: MOVIE_STATUS.DOWNLOADING,
    3: MOVIE_STATUS.QUEUE,
    6: MOVIE_STATUS.DOWNLOADED,
    5: MOVIE_STATUS.DOWNLOADED,
    'undefined': MOVIE_STATUS.UNKNOWN,
}

const transmission = new Transmission({
    host: process.env.TRANSMISSION_HOST,
    username: process.env.TRANSMISSION_USER,
    password: process.env.TRANSMISSION_PW
});

function getTransIdMovie(movie) {
    return new Promise(function (resolve, _reject) {
        setTimeout(function () {
            resolve(undefined)
        }, 1000);
        transmission.addUrl(
            movie.torrent.magnet,
            { 'download-dir': `${process.env.MOVIEPATH}/${movie.title}` },
            function (err, arg) {
                if (err) {
                    resolve(undefined);
                } else {
                    resolve(arg.id);
                }
            })
    });
}
function getTransIdShow(show, sep) {
    return new Promise(function (resolve, _reject) {
        setTimeout(function () {
            resolve(undefined)
        }, 1000);
        transmission.addUrl(
            show[sep].magnet,
            { 'download-dir': `${process.env.SHOWSPATH}/${show.name}/${sep}` },
            function (err, arg) {
                if (err) {
                    resolve(undefined);
                } else {
                    resolve(arg.id);
                }
            })
    });
}
async function appendTransmissionIdMovie(movie) {
    try {
        if (movie.transmissionId) return movie;
        const transmissionId = await getTransIdMovie(movie);
        if (!transmissionId) return movie;
        return { ...movie, transmissionId: transmissionId }
    } catch (error) {
        console.log('append trans id movie error:');
        console.log(error);
    }
    return movie
}
async function appendTransmissionIdShow(show) {
    try {
        for (const sep of showEpIt(show)) {
            if (show[sep] && !show[sep].transmissionId) {
                const transId = await getTransIdShow(show, sep);
                console.log(transId);
                if (transId) show[sep].transmissionId = transId;
            }
        }
        return show;
    } catch (error) {
        console.log('append trans id show error:');
        console.log(error);
    }
    return show;
}

async function getMovieStatus(movie) {
    return new Promise(function (resolve, _reject) {
        try {
            transmission.get([movie.transmissionId], function (err, arg) {
                if (err) {
                    resolve(movie.status);
                } else {
                    if (arg.torrents.length) {
                        resolve(transStatusMap[arg.torrents[0].status]);
                    } else {
                        resolve(MOVIE_STATUS.UNKNOWN);
                    }
                }
            });
        } catch (error) {
            console.log(error);
            resolve(movie.status);
        }
    });
}
async function setMovieStatus(movie) {
    try {
        const status = await getMovieStatus(movie);
        movie.status = status;
        return movie;
    } catch (error) {
        console.log(error);
        return movie;
    }

}
async function deleteItem(item, withData) {
    transmission.remove(item.transmissionId, withData, function (err, arg) {
        if (err) {
            console.log(err);
        } else {
            console.log(`deleted: ${item.title}`);
        }
    });
}

const transmissionMng = {
    appendTransmissionIdMovie,
    appendTransmissionIdShow,
    setMovieStatus,
    deleteItem,
}
export {
    transmissionMng,
}