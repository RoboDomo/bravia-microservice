#!/usr/bin/env bash

# run container without making it a daemon - useful to see logging output
docker run \
    --rm \
    --name="bravia-microservice" \
    -e "BRAVIA_HOSTS=$BRAVIA_HOSTS" \
    -e "MQTT_HOST=$MQTT_HOST" \
    -v $PWD:/home/app \
    robodomo/bravia-microservice
