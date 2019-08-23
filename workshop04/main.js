const { join } = require('path');
const fs = require('fs');
const uuid = require('uuid/v1')

const cacheControl = require('express-cache-controller')
const preconditions = require('express-preconditions')
const cors = require('cors');
const range = require('express-range')
const compression = require('compression')

const { Validator, ValidationError } = require('express-json-validator-middleware')
const  OpenAPIValidator  = require('express-openapi-validator').OpenApiValidator;

const schemaValidator = new Validator({ allErrors: true, verbose: true });

const consul = require('consul')({ promisify: true });

const express = require('express')

const CitiesDB = require('./citiesdb');

const serviceId = uuid().substring(0, 8);
//const serviceName = `zips-${serviceId}`
const serviceName = 'zips'

//Load application keys
//Rename _keys.json file to keys.json
const keys = require('./keys.json')

console.info(`Using ${keys.mongo}`);

// TODO change your databaseName and collectioName
// if they are not the defaults below
const db = CitiesDB({
	connectionUrl: keys.mongo,
	databaseName: 'cities',
	collectionName: 'cities'
});

const app = express();

//Disable etag for this workshop
app.set('etag', false);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Start of workshop

// TODO 1/2 Load schemans
const citySchema = require('./schema/city-schema.json');
//console.info(citySchema);

new OpenAPIValidator(
	{
		apiSpecPath: __dirname + '/schema/city-api.yaml'
	}
).install(app)

// Start of workshop
// TODO 2/2 Copy your routes from workshop02 here


// Mandatory workshop
// TODO GET /api/states
app.get('/api/states', cacheControl({maxAge: 10, public: true}), (req, resp) => {
	console.info('processing /api/states/ ', new Date())
	db.findAllStates()
		.then(result => {
			resp.status(206);
			resp.type('application/json');
			resp.json(
				result.map(v => `/api/state/${v}`)
			);
		})
		.catch(error => {
			resp.status(400);
			resp.type('text/plain');
			resp.send(error);
		})
})

// TODO HEAD /api/state/:state
app.head('/api/state/:state', (req, resp) => {
	const state = req.params.state
	// check if state exist
	resp.status(200);
	resp.type('application/json');
	resp.header('Accept-Ranges', 'cities');
	resp.end();
})

// TODO GET /api/state/:state
const etagFunction = {
	stateAsync: (req) => {
		const state = req.params.state.toLowerCase();
		const p = new Promise(
			(resolve, reject) => {
				db.countCitiesInState(state)
					.then(result => {
						resolve(state + result);  // will return sg3 (3 cities in sg)
					})
					.catch(error => {
						reject(error);
					})
			}
		);
		return (p);
	}
}

app.get('/api/state/:state',
	preconditions(etagFunction),
	cacheControl({noCache: true}),
	range({accept: 'cities', limit: 20}),
	(req, resp) => {
	const state = req.params.state
	const first = req.range.first;
	const last = req.range.last;
	Promise.all([
		db.findCitiesByState(state, {limit: (last - first + 1), offset: first}),
		db.countCitiesInState(state)
	])	.then(results => {
			resp.status(206);
			resp.type('application/json');
			resp.set('ETag', `"${state.toLowerCase()}${results[1]}"`)
			resp.range({
				first: first,
				last: last,
				length: results[1]
			})
			resp.json(
				results[0].map(v => `/api/city/${v}`)
			);
		})
		.catch(error => {
			resp.status(400);
			resp.type('text/plain');
			resp.send(error);
		})
})

// TODO GET /api/city/:cityId
app.get('/api/city/:cityId', (req, resp) => {
	const cityId = req.params.cityId
	db.findCityById(cityId)
		.then(result => {
			resp.type('application/json');
			if (result.length == 0) {
				resp.status(404)
			    resp.json({message: `City ID ${cityId} not found.`});
			} else {
				resp.status(200);
				resp.json(result[0]);
			}
		})
		.catch(error => {
			resp.status(400);
			resp.type('text/plain');
			resp.send(error);
		})
})

// TODO POST /api/city
app.post('/api/city', schemaValidator.validate({body: citySchema}), (req, resp) => {
	const data = req.body;
	db.insertCity(data)
		.then(result => {
			resp.status(201);
			resp.type('application/json');
			resp.json({ message: 'City added successfully.'});
		})
		.catch(error => {
			resp.status(400);
			resp.type('text/plain');
			resp.send(error);
		})
})

// End of workshop

app.get('/health', (req, resp) => {
	console.info(`health check: ${new Date()}`)
	resp.status(200)
		.type('application/json')
		.json({ time: (new Date()).toGMTString() })
})

app.use('/schema', express.static(join(__dirname, 'schema')));

app.use((error, req, resp, next) => {

	if (error instanceof ValidationError) {
		console.error('Schema validation error: ', error)
		return resp.status(400).type('application/json').json({ error: error });
	}

	else if (error.status) {
		console.error('OpenAPI specification error: ', error)
		return resp.status(400).type('application/json').json({ error: error });
	}

	console.error('Error: ', error);
	resp.status(400).type('application/json').json({ error: error });
});

db.getDB()
	.then((db) => {
		const PORT = parseInt(process.argv[2] || process.env.APP_PORT) || 3000;

		console.info('Connected to MongoDB. Starting application');
		app.listen(PORT, () => {
			console.info(`Application started on port ${PORT} at ${new Date()}`);
			console.info(`\tService id: ${serviceId}`);

			// TODO 3/3 Add service registration here
			console.info(`Registering service ${serviceName}:${serviceId}`);
			consul.agent.service.register({
				id: serviceId,
				name: serviceName,
				port: PORT,
				check: {
					ttl : '10s', //time to live
					deregistercriticalserviceafter: '30s'
				}
			})
			.then(() => {
				const intId = setInterval(
					() => {
						consul.agent.check.pass({
							id: `${serviceName}:${serviceId}`
						})
					},
					10 * 1000		// 10 seconds
				)
				process.on('SIGINT',
					() => {
						console.info(`Deregistering ${serviceName}:${serviceId}`);
						clearInterval(intId);
						consul.agent.service.deregister(
							{id: `${serviceName}:${serviceId}`}
						).finally( () => process.exit() )
					}
				)
			})
		});
	})
	.catch(error => {
		console.error('Cannot connect to mongo: ', error);
		process.exit(1);
	});
