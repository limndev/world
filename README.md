# 모두 함께 만드는 우리의 공간

학생들이 자연 꾸미기(돌·꽃·작은 나무·동물·연못 등 12가지)로 함께 꾸미며 걸어 다니는 교실용 웹앱. Phaser 3 + Supabase, 빌드 없는 정적 사이트(Vercel).

## 파일
- `index.html`, `styles.css`, `app.js` — 화면, 입장, 걷기, 접속 상태
- `placement.js` — 자연 꾸미기(놓기·옮기기·지우기) 패널
- `code.html`, `code-maker.js` — 선생님용 무작위 입장 코드 만들기(코드·SQL 파일 내려받기)
- `art.js` — 그림을 만드는 파일. 그림 파일(SVG) 없이 브라우저가 시작할 때 캔버스로 풍경·나무·바위·꽃·캐릭터를 직접 그림(빛은 왼쪽 위, 그림자는 오른쪽 아래로 통일)
- `placement-rules.js` — 놓을 수 있는 자리 규칙(서버 SQL 반경과 같은 값, 테스트로 확인)
- `data.js` — Supabase 연결부와 서버 없는 시험용 가짜 데이터
- `nature-config.js` — Supabase URL과 Publishable key(공개해도 되는 키)
- `supabase/migrations/` — 0001~0003 (이미 적용됨), 0004(꾸미기 12종·시연용 코드 표 — **배포 전에 Supabase SQL Editor에서 한 번 실행**)
- `vendor/` — Phaser, supabase-js (학교망에서 CDN이 막혀도 되도록 직접 포함)

## 올리면 안 되는 것
Secret key(service_role), 학급 입장 코드(공용·시연용), 코드가 적힌 파일(`join-code-*.txt`).

## 시험
- `node --test tests/rules.test.js` — 규칙 단위 시험(서버 SQL 0004의 반경표·허용 종류와 화면 규칙이 같은지도 확인)
- `node tests/e2e.js` — Playwright 브라우저 시험(가짜 서버). 진짜 Supabase는 확인하지 못함.
- 주소 뒤에 `?dev=1` 을 붙이면 서버 없이 입장하는 시험 버튼이 보임.

## 진짜 Supabase 확인 목록 (탭 2개, 발표 전날 밤에)
1. Supabase 대시보드 → Authentication: **Anonymous sign-ins** 켜짐 확인. Rate Limits의 익명 로그인 한도(기본 시간당 IP당 30)는 올려 두면 안전.
2. 탭 A에서 입장 코드 입력 → 월드가 보이는가.
3. 시크릿 창(탭 B)에서 같은 코드로 입장 → A의 "함께 있는 친구"에 B가 나오는가.
4. A에서 걸으면 B 화면의 A가 따라 움직이는가.
5. A에서 돌 놓기 → B에도 보이는가(5초 안).
6. A에서 옮기기, 지우기(두 번 누르기) → B에서도 반영되는가.
7. 물·길·나무 위, 겹침, 12개 초과, 2초 안 연속 변경에서 안내 문구가 나오는가.
8. 새로고침 → 코드 다시 묻지 않고 들어가는가.
9. 가능하면 학교 와이파이에서 같은 시험. 화면 아래에 "실시간 연결 불가" 안내가 나와도 놓은 것이 5초 안에 보이면 정상(대체 경로).
