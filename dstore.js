const fs = require('fs');

const store = {
    storeURI: './store.json',
    data: {},
    save: function () {
        fs.writeFile(this.storeURI, JSON.stringify(this.data), error => {
            if (error) console.log(error);
        });
    },
    load: async function () {
        this.data = JSON.parse(fs.readFileSync(this.storeURI, 'utf8'));
        return this.data;
    }
}

module.exports = store



const example = {
    movies: [
        {
            term: "GEORGETOWN 1080",
            magnet: undefined,
            torrent: undefined
        }
    ],
    series: [
        {
            term: "Brooklyn nine nine",
            active: false,
            magnets: [
                {
                    episode: "S01E01",
                    magnet: "magnet:?xt=urn:btih:BAF111C33C68A9284CA90761F67AC32B7F3FC8AF&dn=Brooklyn%20Nine%20Nine%20S01E01%20HDTV%20x264-LOL%20%5Beztv%5D&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2F47.ip-51-68-199.eu%3A6969%2Fannounce",
                    torrent: {
                        title: 'Brooklyn Nine Nine S01E01 HDTV x264-LOL [eztv]',
                        time: "Apr. 15th 2013",
                        seeds: 69,
                        peers: 8,
                        size: '895.7 MB',
                        desc: 'https://torrentz2.cyou/tor?id=8931632',
                        provider: '1337x'
                    },
                }
            ]
        }
    ]
}

//store.data = example;
//store.save();