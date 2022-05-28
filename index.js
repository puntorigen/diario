!(async()=>{
    //PoC: index companies of the day and their PDF on an sqlite DB
    /* 
    indexation steps: (this file or command)
        0) prepare the DB & tables
        1) build the url with current date
        2) extract the companies with their PDF
        3) download & parse each PDF and extract its info as text
        4) add the data to the sqlite DB (we can replace it with a remote DB later)

    search steps:
        1) read the sqlite DB
        2) search the DB for the given parameters
        3) call a webhook (could be defined on a .env file)
    */
    // import libraries
    const axios = require('axios'), cheerio = require('cheerio');
    const x_console = new (require('@concepto/console'))();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    x_console.setColorTokens({
        '!': 'yellow',
        '#': 'green'
    });
    // 
    const downloadFile = async(uri)=>{
        //get tmpdir
        const promisify = require('util').promisify;
        const tmpdir = promisify(require('tmp').dir);
        const dir = await tmpdir(); //create tmpdir
        //download file to tmp dir
        const dl = require('download-file-with-progressbar');
        const asPromise = ()=>new Promise((resolve,reject)=>{
            const dd = dl(uri,{
                dir,
                onDone: (info)=>{
                    resolve(info);
                },
                onProgress: (x)=>{
                },
                onError: (err)=>{
                    reject(err);
                }
            });
        });
        const down = await asPromise();
        return down.path;
    };
    const prepareDB = ()=>{
        const db = require('better-sqlite3')('local.db',{});
        db.exec(`CREATE TABLE IF NOT EXISTS records('name' varchar, 'extra' varchar, 'topic' varchar, 'group' varchar, 'cve' varchar, 'date' date, 'pdf_url' text, 'pdf_text' text, 'pdf_json' text);`); //
        return db;
    };
    const buildBaseUrl = (date)=>{
        const dayjs = require('dayjs');
        let today = dayjs().format('DD-MM-YYYY');
        if (date && date.trim()!='') today = date; //forced value
        return `https://www.diariooficial.interior.gob.cl/edicionelectronica/index.php?date=${today}`;
    };
    const getWebsiteContent = async(uri)=>{
        try {
            const resp = (await axios.get(uri)).data;
            return resp;
        } catch(err) {
            x_console.outT({ message:`An error ocurred retrieving: ${uri}`, data:err });
            return '';
        }
    };
    const getTopics = async(date='')=>{
        //get topic links from 'diario' with edition key
        let links = [];
        const data = await getWebsiteContent(buildBaseUrl(date));
        const dayjs = require('dayjs');
        let today = dayjs().format('DD-MM-YYYY');
        let date_ = (date!='')?date:today;
        let $ = cheerio.load(data,{});
        const nav_a = $('nav[class=menu] a[href]').toArray();
        if (nav_a.length==0) {
            // sometimes there is more than 1 version of the bulletin
            // get versions first, then build nav list
            const vers = $('li a[href*=v\=]').toArray();
            //let versions = [];
            for (let v in vers) {
                const v_ = $(vers[v]);
                const link_ = 'https://www.diariooficial.interior.gob.cl/edicionelectronica/'+v_.attr('href');
                const data = await getWebsiteContent(link_);
                let $2 = cheerio.load(data,{});
                const nav_a = $2('nav[class=menu] a[href]').toArray();
                for (let x in nav_a) {
                    let edition = -1;
                    const item_ = $2(nav_a[x]), link = item_.attr('href');
                    if (link.indexOf('edition')!=-1) {
                        edition = link.split('&').pop().split('=').pop();
                    }
                    links.push({ name:item_.html().replace('<br>',' ').trim(),link, edition, date:date_ });
                }
                //versions.push(link_);
            }
            //console.log('vers',versions);
        } else {
            for (let x in nav_a) {
                let edition = -1;
                const item_ = $(nav_a[x]), link = item_.attr('href');
                if (link.indexOf('edition')!=-1) {
                    edition = link.split('&').pop().split('=').pop();
                }
                links.push({ name:item_.html().replace('<br>',' ').trim(),link, edition, date:date_ });
            }
        }
        return links;
    };
    const parsePDF = async(uri,minWordLen=5,retry=3)=>{
        try {
            let localFile = await downloadFile(uri);
            //extract PDF data
            const fs = require('fs').promises;
            const pdfParse = require('pdf-parse');
            const countWords = require('count-words');
            const dataBuffer = await fs.readFile(localFile);
            const pdf = await pdfParse(dataBuffer);
            let words_ = {}; 
            try { 
                words_ = countWords(pdf.text,true);
                Object.keys(words_).forEach((key)=>{
                    if (key.length<=minWordLen) { // || words_[key]==1
                        delete words_[key];
                    }
                });
            } catch(e) {}
            let wordKeys = Object.keys(words_);
            let resp = { 
                pages: pdf.numpages,
                meta: {
                    title:(pdf.info.Title)?pdf.info.Title:'',
                    author:(pdf.info.Author)?pdf.info.Author:'',
                    keywords:(pdf.info.Keywords)?pdf.info.Keywords:'',
                    createdAt:(pdf.info.CreationDate)?pdf.info.CreationDate.replace('D:','').split('-')[0]:'',
                    cve: (pdf.info.Keywords)?parseInt(pdf.info.Keywords.split(',').pop().split(':')[1].trim()):''
                },
                text: pdf.text,
                //words: words_,
                shorted: false,
                wordCount: wordKeys.length, 
                wordList: wordKeys.join(',') 
            };
            if (resp.text.length>100000) {
                resp.text = resp.wordList;
                resp.shorted = true;
            }
            return resp;
        } catch(errDown) {
            if (retry>0) {
                x_console.outT({ color:'brightRed', message:`Error downloading PDF ${uri} (re-trying again)` });
                await sleep(100+(Math.abs(5-retry)*100));
                return (await parsePDF(uri,minWordLen,(retry-1)));
            }
        }

        return resp;
    };
    const scrapeData = async(topics,maxRecords=100)=>{
        let resp = [];
        //PoC get & scrape companies link data
        for (let topic_ in topics) {
            try {
                await sleep(50);
                const new_link = `https://www.diariooficial.interior.gob.cl/edicionelectronica/${topics[topic_].link}`;
                const $ = cheerio.load(await getWebsiteContent(new_link),{});
                let td = $('tr td').toArray();
                let type_ = '';
                let topicName = topics[topic_].name;
                x_console.setPrefix({ prefix:topicName, color:'cyan' });
                for (let i=0; i<Math.min(maxRecords,td.length); i++) {
                    const item_ = $(td[i]);
                    const row = { topic:topicName, date:topics[topic_].date };
                    const tdClass = item_.attr('class');
                    const trClass = item_.parent('tr').attr('class');
                    if (tdClass=='title3') {
                        type_ = item_.text().trim();
                    }
                    if (trClass=='content' && type_!='') {
                        //parse content
                        const $2 = cheerio.load(item_.html());
                        const divs = $2('div').toArray();
                        row.group = type_;
                        let hasLink = item_.children('a').toArray();
                        if (divs.length==3) {
                            // company
                            row.type = 'company';
                            row.name = $(divs[0]).text().trim();
                            row.rut = $(divs[1]).text().trim();
                            const shortName = row.name.split(' ').splice(0,Math.min(row.name.split(' ').length,10));
                            x_console.outT({ message:`Parsing record '#${shortName} ..#'`, color:'magenta' });
                            //get pdf link
                            let pdf_ = $(td[i+1]).children('a').toArray();
                            if (pdf_.length>0) row.pdf = $(pdf_[0]).attr('href');
                            //download and extract PDF text
                            if (row.pdf) {
                                row.pdf_data = await parsePDF(row.pdf);
                                row.objectID = row.pdf_data.meta.cve;
                            }
                            resp.push(row);

                        } else if (hasLink.length==0) {
                            // goverment type record (& not pdf type cell)
                            row.type = 'gov';
                            row.name = item_.text().trim();
                            const shortName = row.name.split(' ').splice(0,Math.min(row.name.split(' ').length,10));
                            x_console.outT({ message:`Parsing !gov! record '#${shortName} ..#'`, color:'yellow'});
                            //get pdf link
                            let pdf_ = $(td[i+1]).children('a').toArray();
                            if (pdf_.length>0) row.pdf = $(pdf_[0]).attr('href');
                            //download and extract PDF text
                            if (row.pdf) {
                                row.pdf_data = await parsePDF(row.pdf);
                                row.objectID = row.pdf_data.meta.cve;
                            }
                            resp.push(row);
                        }
                    }
                }
            } catch(err) {
                x_console.outT({ color:'brightRed', message:`An error ocurred requestng topic '${topics[topic_].name}'`, data:err });
            }
        }
        return resp;
    };
    //
    // Execute steps
    //
    require('dotenv').config();
    x_console.title({ title:`Diario Oficial's Parser & Indexer`, color:'cyan', titleColor:'yellow' });
    const db = prepareDB();
    const forDate = process.env.DATE.trim(); //23-05-2022 JOSE: change the date here (empty means today)
    x_console.out({ message:`Getting topics .. for date !${(forDate!='')?forDate:'today'}!`});
    const topics = await getTopics(forDate); //get all topics (and all versions of them)
    //const filteredTopics = topics.filter((i)=>i.name.toLocaleLowerCase().includes('normas')); //filter topics to search
    //x_console.out({ message:'Topics .. ', data:topics});
    const data = await scrapeData(topics,process.env.MAX_RECORDS_PER_TOPIC);
    //show console stats per topic
    let stats = [];
    topics.forEach((topic)=>{
        let records = 0;
        data.forEach((row)=>{
            if (topic.name==row.topic) {
                records += 1;
            }
        });
        stats.push({ topic:topic.name, records, date:forDate });
    })
    console.log(`\n\n`);
    x_console.table({ data:stats, title:'Stats', color:'dim', titleColor:'white' });
    console.log(`\n`);
    //@TODO insert records to DB
    data.forEach(async (row)=>{

    });
    //db.exec('INSERT INTO records(name,extra,topic,group,cve,date,pdf_url,pdf_text,pdf_json) VALUES()');
    //send to algolia servers
    x_console.title({ title:`Upload to Algolia`, color:'blue' });
    //send data to algolia.com servers
    const algoliasearch = require('algoliasearch');
    const client = algoliasearch(process.env.ALGOLIA_APP_ID,process.env.ALGOLIA_ADMIN_API_KEY); //appid,admin api key
    const index = client.initIndex(process.env.ALGOLIA_INDEX);
    x_console.outT({ prefix:'Algolia', message:`sending ${data.length} records to Algolia ..`, color:'yellow'});
    try {
        await index.saveObjects(data);
    } catch(err) {
        x_console.out({ message:`Error sending data`, color:'brightRed', data:err });
    }
    x_console.outT({ prefix:'Algolia', message:'ready', color:'yellow'});
    //algolia ready

})()