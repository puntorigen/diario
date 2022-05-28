# Diario Oficial - Autommatic Scrapper and Indexer
![diario-logo](https://user-images.githubusercontent.com/57605485/170844197-e1ac9ed0-6719-4663-b01e-040409bc6b64.png)

Extracts the all of the "diario oficial" web records for the given day (or today if empty) and saves them in the defined Angolia account. 
Works by defining an .env file within root with the following variables:

```env
ALGOLIA_APP_ID="YOUR ANGOLIA APPID"
ALGOLIA_ADMIN_API_KEY="YOUR ANGOLIA ADMIN API KEY"
ALGOLIA_INDEX="YOUR ANGOLIA RECORD INDEX NAME"

#config options
MAX_RECORDS_PER_TOPIC=1000 #(max records to process per topic)

#date to extract; empty means today
DATE=20-05-2022
```

Note: Angolia charges aprox 1,5 usd per 1000 records over 10.000, so the free account gives you aprox 10 days of data for free.