import requests
from datetime import datetime as dt, timezone as tz

def currentNasaTime():
    localNow = dt.now()
    UTCNow = localNow.astimezone(tz.utc)
    return UTCNow.strftime("%Y%m%d:%H")

def windData(lat, long):
    timestamp = currentNasaTime()
    url = f"https://power.larc.nasa.gov/api/application/windrose/point?longitude={long}&latitude={lat}&start={timestamp}&end={timestamp}&format=JSON"
    
    response = requests.get(url)
    if response.status_code != 200:
        print("Error fetching wind data! :(")
        return None, None

    data = response.json()
    wind_speed = data.get("WS10M", {}).get(timestamp, None)
    wind_direction = data.get("WD10M", {}).get(timestamp, None)

    return wind_speed, wind_direction

# ===== Example usage =====
latitude = 33.64
longitude = -84.43

speed, direction = windData(latitude, longitude)

if speed is not None and direction is not None:
    print(f"Current Wind Speed: {speed} m/s")
    print(f"Current Wind Direction: {direction}°")
else:
    print("Could not fetch wind data.")
