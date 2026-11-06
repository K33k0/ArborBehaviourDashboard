"""Orme ACE + AtL + Attendance dashboard. Python standard library only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from pathlib import Path
from html import escape
from datetime import datetime, timedelta
from threading import Lock
from time import monotonic
import argparse
import base64
import binascii
import json
import re
import math
import webbrowser

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / 'config.json'


def load_config():
    try:
        settings = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise SystemExit('config.json not found. Copy config.example.json to config.json and enter your feed details.')
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f'Could not read config.json: {exc}')

    if not isinstance(settings, dict):
        raise SystemExit('config.json must contain a JSON object.')

    server = settings.get('server', {})
    if not isinstance(server, dict):
        raise SystemExit('config.json server must be an object.')
    host = server.get('host', '127.0.0.1')
    port = server.get('port', 3000)
    if not isinstance(host, str) or not host or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise SystemExit('Invalid server host or port in config.json.')

    default_auth = settings.get('authorization', '')
    feed_settings = settings.get('feeds', {})
    if not isinstance(feed_settings, dict):
        raise SystemExit('config.json feeds must be an object.')
    feeds = {}
    for name in ('ace', 'atl', 'attendance_form', 'attendance_year'):
        feed = feed_settings.get(name)
        if not isinstance(feed, dict):
            raise SystemExit(f'Missing feeds.{name} object in config.json.')
        url = feed.get('url', '')
        auth = feed.get('authorization') or default_auth
        if not isinstance(url, str) or not url.startswith('https://') or not isinstance(auth, str) or not auth.startswith('Basic '):
            raise SystemExit(f'Invalid URL or Basic authorisation for feeds.{name}.')
        feeds[name] = {'url': url, 'auth': auth}
    logo_base64 = settings.get('logo_base64')
    logo = None
    if logo_base64 is not None:
        try:
            logo = base64.b64decode(logo_base64, validate=True)
        except (ValueError, TypeError, binascii.Error):
            raise SystemExit('config.json logo_base64 must contain a base64-encoded PNG.')
        if not logo.startswith(b'\x89PNG\r\n\x1a\n'):
            raise SystemExit('config.json logo_base64 must contain a base64-encoded PNG.')
    school_name = settings.get('school_name', 'School')
    ethos = settings.get('ethos', '')
    if not isinstance(school_name, str) or not school_name.strip() or not isinstance(ethos, str):
        raise SystemExit('config.json school_name must be non-empty text and ethos must be text.')
    return host, port, feeds, logo, school_name, ethos


HOST, PORT, FEEDS, LOGO, SCHOOL_NAME, ETHOS = load_config()
BRANDING = {
    'SCHOOL_NAME': escape(SCHOOL_NAME),
    'SCHOOL_INITIAL': escape(SCHOOL_NAME.strip()[0].upper()),
    'ETHOS': escape(ETHOS),
}

# Independent cached data per feed. Lock ensures concurrent browsers cannot
# trigger duplicate requests. After failure, the last successful data remains.
locks = {name: Lock() for name in FEEDS}
caches = {name: {'slot': None, 'retry_at': 0, 'groups': [], 'updated': None, 'error': None} for name in FEEDS}


def slot_start(now):
    base = now.replace(second=0, microsecond=0)
    if now.minute >= 45:
        return base.replace(minute=45)
    if now.minute >= 15:
        return base.replace(minute=15)
    return (base - timedelta(hours=1)).replace(minute=45)


def rows_from_json(obj):
    if isinstance(obj, list):
        if all(isinstance(item, dict) for item in obj):
            return obj
        raise ValueError('JSON list does not contain row objects')
    if isinstance(obj, dict):
        for key in ('data', 'rows', 'results', 'records', 'items'):
            if key in obj:
                return rows_from_json(obj[key])
        for value in obj.values():
            if isinstance(value, (dict, list)):
                try:
                    return rows_from_json(value)
                except ValueError:
                    pass
    raise ValueError('Cannot find a list of row objects in Arbor JSON')


def norm(key):
    return re.sub(r'[^a-z0-9]+', '', str(key).lower())


def get_field(row, predicate):
    for key, value in row.items():
        if predicate(norm(key)):
            return value
    raise ValueError('Missing field; available JSON keys: ' + ', '.join(map(str, row)))


def numeric(value):
    if isinstance(value, bool):
        raise ValueError('Boolean is not numeric')
    number = float(str(value).replace(',', '').strip())
    if not math.isfinite(number):
        raise ValueError('Non-finite number')
    return number


def transform(obj, kind):
    groups, seen = [], set()
    for row in rows_from_json(obj):
        form = str(get_field(row, lambda k: 'registrationform' in k or k == 'form')).strip()
        year_raw = str(get_field(row, lambda k: 'yeargroup' in k or k == 'year')).strip()
        if year_raw.lower() == 'overall':
            continue  # Some grouped Arbor reports include Overall subtotals.
        found = re.search(r'\d+', year_raw)
        if not found or not form:
            raise ValueError(f'Invalid form/year: {form!r} / {year_raw!r}')
        year = int(found.group())
        if not (7 <= year <= 11):
            continue
        key = (year, form)
        if key in seen:
            raise ValueError(f'Duplicate form: Year {year}, {form}')
        seen.add(key)
        if kind == 'ace':
            points = numeric(get_field(row, lambda k: 'pointawardsace' in k or 'totalpointawardsace' in k))
            pupils = numeric(get_field(row, lambda k: k == 'groupsize' or k == 'pupilcount'))
            if pupils <= 0 or pupils != int(pupils) or points < 0:
                raise ValueError(f'Invalid ACE values for {form}')
            groups.append({'year': year, 'form': form, 'points': points,
                           'pupils': int(pupils), 'average': round(points / pupils, 4)})
        else:
            points = numeric(get_field(row, lambda k: 'pointawardsatl' in k or 'totalpointawardsatl' in k))
            count = numeric(get_field(row, lambda k: 'pointawardcountstatisticatl' in k))
            if count < 0 or count != int(count) or points < 0:
                raise ValueError(f'Invalid AtL values for {form}')
            # Explicit null: a form with no AtL awards must not rank first.
            average = points / count if count else None
            if count == 0 and points != 0:
                raise ValueError(f'AtL points with zero awards for {form}')
            groups.append({'year': year, 'form': form, 'points': points,
                           'awards': int(count), 'average': round(average, 4) if average is not None else None})
    if not groups:
        raise ValueError('No usable grouped rows in Arbor feed')
    return groups



def attendance_percentage(row):
    # Arbor's exact column key may vary by report configuration.
    # Be strict about matching a statutory/roll-call attendance field;
    # do not silently select another unrelated percentage.
    matches = [(key, value) for key, value in row.items()
               if (('statutoryrollcallattendance' in norm(key)
                    or 'rollcallattendance' in norm(key))
                   and ('present' in norm(key) or 'attendancepercentage' in norm(key)
                        or 'attendancepercent' in norm(key)))]
    if len(matches) != 1:
        raise ValueError('Expected one statutory/roll-call attendance percentage field; found keys: '
                         + ', '.join(map(str, row)))
    raw = str(matches[0][1]).strip()
    if not raw or raw.lower() in ('none', 'null', 'n/a', '-', '—'):
        return None
    pct = numeric(raw.rstrip('%').strip())
    if not 0 <= pct <= 100:
        raise ValueError('Attendance percentage is outside 0–100: ' + raw)
    return round(pct, 4)


def transform_attendance(obj, kind):
    results, seen = [], set()
    for row in rows_from_json(obj):
        if kind == 'attendance_form':
            form = str(get_field(row, lambda k: 'registrationform' in k or k == 'form')).strip()
            year_raw = str(get_field(row, lambda k: 'yeargroup' in k or k == 'year')).strip()
            if year_raw.lower() == 'overall' or form.lower() == 'overall':
                continue
        else:
            form = None
            year_raw = str(get_field(row, lambda k: 'yeargroup' in k or k == 'year')).strip()
            if year_raw.lower() == 'overall':
                continue
        found = re.search(r'\d+', year_raw)
        if not found:
            raise ValueError('Invalid attendance year: ' + year_raw)
        year = int(found.group())
        if not 7 <= year <= 11:
            continue
        key = (year, form)
        if key in seen:
            raise ValueError('Duplicate attendance group: ' + str(key))
        seen.add(key)
        if kind == 'attendance_form' and not form:
            raise ValueError('Missing registration form for year ' + str(year))
        results.append({'year': year, **({'form': form} if form else {}),
                        'average': attendance_percentage(row)})
    if not results:
        raise ValueError('No usable grouped attendance rows')
    return results

def get_dashboard(kind):
    with locks[kind]:
        cache = caches[kind]
        slot = slot_start(datetime.now().astimezone()).isoformat()
        if cache['slot'] != slot and monotonic() >= cache['retry_at']:
            try:
                config = FEEDS[kind]
                request = Request(config['url'], headers={
                    'Authorization': config['auth'],
                    'Accept': 'application/json',
                    'User-Agent': 'SchoolLeaderboard/2.0'
                })
                with urlopen(request, timeout=30) as response:
                    payload = json.load(response)
                groups = transform_attendance(payload, kind) if kind.startswith('attendance_') else transform(payload, kind)
                cache['groups'] = groups
                cache['updated'] = datetime.now().astimezone().isoformat(timespec='seconds')
                cache['error'] = None
                cache['slot'] = slot
                cache['retry_at'] = 0
                print(f'Updated {kind.upper()}: {len(groups)} forms at {cache["updated"]}')
            except (HTTPError, URLError, TimeoutError, ValueError, TypeError,
                    KeyError, json.JSONDecodeError) as exc:
                cache['error'] = type(exc).__name__ + ': ' + str(exc)
                cache['retry_at'] = monotonic() + 60
                print(f'{kind.upper()} update failed:', cache['error'])
        return {'updated': cache['updated'], 'stale': cache['error'] is not None,
                'groups': cache['groups'],
                'error': 'Update unavailable; previous results displayed' if cache['error'] else None}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/api/ace', '/api/atl', '/api/attendance_form', '/api/attendance_year'):
            kind = path.rsplit('/', 1)[-1]
            self.reply(json.dumps(get_dashboard(kind), allow_nan=False).encode('utf-8'), 'application/json; charset=utf-8')
        elif path in ('/', '/index.html', '/ace', '/ace/', '/atl', '/atl/',
                      '/attendance', '/attendance/'):
            self.serve('index.html', 'text/html; charset=utf-8')
        elif path == '/app.js':
            self.serve('app.js', 'text/javascript; charset=utf-8')
        elif path == '/styles.css':
            self.serve('styles.css', 'text/css; charset=utf-8')
        elif path == '/logo.png':
            if LOGO is None:
                self.serve('logo.png', 'image/png')
            else:
                self.reply(LOGO, 'image/png')
        else:
            self.send_error(404)

    def serve(self, name, mime):
        try:
            path = ROOT / name
            if name == 'index.html':
                template = path.read_text(encoding='utf-8')
                content = re.sub(r'\{\{(SCHOOL_NAME|SCHOOL_INITIAL|ETHOS)\}\}',
                                 lambda match: BRANDING[match[1]], template).encode('utf-8')
            else:
                content = path.read_bytes()
            self.reply(content, mime)
        except OSError:
            self.send_error(404)

    def reply(self, content, mime):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(content)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    browser_host = '127.0.0.1' if HOST == '0.0.0.0' else HOST
    dashboard_url = f'http://{browser_host}:{PORT}'
    print(f'ACE + AtL + Attendance dashboard: {dashboard_url}')
    try:
        if args.open_browser:
            webbrowser.open(dashboard_url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
